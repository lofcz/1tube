using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace OneTube.Secrets;

/// <summary>
/// File-backed key/value store for runtime-editable secrets that
/// layer on top of <see cref="OneTubeOptions.EnvVars"/>. Secrets
/// always win on key collision — appCfg holds the defaults, the
/// store holds the overrides.
///
/// <para>Reads return an immutable snapshot, so callers can iterate
/// the result without holding any lock. Writes go through a single
/// internal lock and are persisted atomically (write-temp, replace).
/// The store fires <see cref="Changed"/> on every mutation; the
/// watch+reload pipeline subscribes to debounce and trigger a
/// gateway side-by-side swap.</para>
///
/// <para>Validation is strict enough for process environment keys
/// (<c>[A-Z0-9_]+</c>, case-insensitive) while still accepting the
/// gateway's documented <c>1TUBE_*</c> namespace. A small reserved set
/// is rejected to keep gateway-controlled vars off the override path.</para>
/// </summary>
public sealed class SecretsStore
{
    private readonly SecretsOptions _options;
    private readonly ILogger<SecretsStore> _logger;
    private readonly string _absolutePath;
    private readonly object _writeLock = new();

    // Current snapshot. Replaced (not mutated) on every change so
    // readers that captured a reference keep iterating consistently.
    private ImmutableDictionary<string, string> _values =
        ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal);

    /// <summary>
    /// Fires after every successful mutation (set/delete/bulk).
    /// Handlers run synchronously on the writer's thread; keep them
    /// short — the hot-swap watcher posts the work onto its own
    /// debounce timer rather than blocking the API request.
    /// </summary>
    public event Action? Changed;

    public SecretsStore(IOptions<SecretsOptions> options, ILogger<SecretsStore> logger)
    {
        _options = options.Value;
        _logger = logger;

        if (string.IsNullOrWhiteSpace(_options.Path))
        {
            throw new InvalidOperationException(
                "SecretsOptions.Path is required when secrets are enabled. " +
                "Set it to e.g. \"onetube/data/secrets.json\" relative to the host's bin/.");
        }

        _absolutePath = Path.IsPathRooted(_options.Path)
            ? _options.Path
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, _options.Path));

        var dir = Path.GetDirectoryName(_absolutePath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        Load();
    }

    /// <summary>
    /// Snapshot of all secrets. Safe to enumerate without locking.
    /// Returns the SAME instance for unchanged state (cheap reads).
    /// </summary>
    public ImmutableDictionary<string, string> Snapshot() => _values;

    /// <summary>
    /// Just the keys, in stable order. Cheap to call from list
    /// endpoints — no allocations beyond the array itself.
    /// </summary>
    public IReadOnlyList<string> Keys()
    {
        var snap = _values;
        var keys = snap.Keys.ToArray();
        Array.Sort(keys, StringComparer.Ordinal);
        return keys;
    }

    /// <summary>
    /// Read a single value. Returns null when the key is absent so
    /// callers can decide whether to 404 or fall back to appCfg.
    /// </summary>
    public string? Get(string key) => _values.TryGetValue(key, out var v) ? v : null;

    /// <summary>
    /// Set or replace a single key. Validates key + value, persists
    /// atomically, fires <see cref="Changed"/>. Returns true if the
    /// store actually changed (set with a different value or a new
    /// key); false on a no-op (same value already present).
    /// </summary>
    public bool Set(string key, string value)
    {
        ValidateKey(key);
        ValidateValue(value);

        lock (_writeLock)
        {
            if (_values.TryGetValue(key, out var existing) && existing == value) return false;
            var next = _values.SetItem(key, value);
            Persist(next);
            _values = next;
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>
    /// Remove a key. Returns true if the key existed; false if it
    /// was already absent. Even the no-op path skips
    /// <see cref="Changed"/> — no point reloading the gateway over
    /// a delete that didn't change the config.
    /// </summary>
    public bool Delete(string key)
    {
        ValidateKey(key);
        lock (_writeLock)
        {
            if (!_values.ContainsKey(key)) return false;
            var next = _values.Remove(key);
            Persist(next);
            _values = next;
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>
    /// Bulk replace: the supplied map becomes the new full state.
    /// Useful for "paste the whole secrets.json from another
    /// environment" admin flows. Validates every key/value before
    /// touching disk so a single bad entry rejects the entire
    /// transaction.
    /// </summary>
    public bool ReplaceAll(IReadOnlyDictionary<string, string> map)
    {
        foreach (var (k, v) in map) { ValidateKey(k); ValidateValue(v); }

        var next = ImmutableDictionary.CreateRange(StringComparer.Ordinal, map);
        lock (_writeLock)
        {
            if (next.Count == _values.Count && next.All(kv =>
                _values.TryGetValue(kv.Key, out var existing) && existing == kv.Value))
            {
                return false;
            }
            Persist(next);
            _values = next;
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>
    /// Re-read the file from disk. Call this if an out-of-band edit
    /// (operator hand-edited secrets.json) needs to be picked up.
    /// Not wired to a FileSystemWatcher because filesystem-watch
    /// semantics on Windows network shares are notoriously flaky;
    /// the operator can hit a "/reload" endpoint or restart the
    /// host instead.
    /// </summary>
    public void Reload()
    {
        lock (_writeLock) Load();
        Changed?.Invoke();
    }

    // ── Internals ────────────────────────────────────────────────

    private void Load()
    {
        if (!File.Exists(_absolutePath))
        {
            _values = ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal);
            return;
        }

        try
        {
            var bytes = File.ReadAllBytes(_absolutePath);
            // Empty file is treated as "no secrets" so a touch-only
            // first install doesn't trip a JSON parse error.
            if (bytes.Length == 0)
            {
                _values = ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal);
                return;
            }
            var doc = JsonSerializer.Deserialize<SecretsFile>(bytes, s_jsonOpts);
            if (doc?.Secrets is null)
            {
                _values = ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal);
                return;
            }
            _values = ImmutableDictionary.CreateRange(StringComparer.Ordinal, doc.Secrets);
            _logger.LogInformation(
                "[1tube/secrets] loaded {Count} secret(s) from {Path}",
                _values.Count, _absolutePath);
        }
        catch (Exception ex)
        {
            // We deliberately do NOT throw here — a corrupt
            // secrets.json shouldn't take the host down. Log loudly
            // and start with an empty store; the operator can fix
            // the file and hit /reload (or restart the host).
            _logger.LogError(ex,
                "[1tube/secrets] failed to read {Path}; starting with empty store. " +
                "Edit the file or restage to recover.", _absolutePath);
            _values = ImmutableDictionary<string, string>.Empty.WithComparers(StringComparer.Ordinal);
        }
    }

    private void Persist(ImmutableDictionary<string, string> values)
    {
        var doc = new SecretsFile
        {
            SchemaVersion = 1,
            UpdatedAt = DateTime.UtcNow.ToString("O"),
            Secrets = values.OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.Ordinal),
        };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(doc, s_jsonOpts);

        // Atomic write: write to a sibling temp file, then File.Replace
        // (or Move with overwrite when no destination exists yet).
        // File.Replace gives us atomic-on-NTFS semantics and a backup
        // path slot we ignore — but it requires the destination to
        // already exist. First-write falls back to Move.
        var tmp = _absolutePath + ".tmp";
        File.WriteAllBytes(tmp, bytes);
        if (File.Exists(_absolutePath))
        {
            File.Replace(tmp, _absolutePath, destinationBackupFileName: null);
        }
        else
        {
            File.Move(tmp, _absolutePath);
        }
    }

    private static readonly JsonSerializerOptions s_jsonOpts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
    };

    private static readonly Regex s_keyRe = new("^[A-Za-z0-9_]+$", RegexOptions.Compiled);

    private static void ValidateKey(string key)
    {
        if (string.IsNullOrEmpty(key))
            throw new ArgumentException("secret key must not be empty", nameof(key));
        if (key.Length > 256)
            throw new ArgumentException("secret key too long (max 256 chars)", nameof(key));
        if (!s_keyRe.IsMatch(key))
            throw new ArgumentException(
                $"secret key '{key}' is not a valid gateway env var name " +
                "([A-Za-z0-9_]+)", nameof(key));
        if (SecretsOptions.ReservedKeys.Contains(key))
            throw new ArgumentException(
                $"secret key '{key}' is reserved by the gateway and cannot be overridden", nameof(key));
    }

    private static void ValidateValue(string value)
    {
        if (value is null) throw new ArgumentNullException(nameof(value));
        // 1 MB cap. Real secrets are kilobytes at most; anything
        // bigger than this is almost certainly a paste accident
        // and would bloat every gateway env.
        if (value.Length > 1_048_576)
            throw new ArgumentException("secret value too long (max 1 MiB)", nameof(value));
    }

    private sealed class SecretsFile
    {
        [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; set; }
        [JsonPropertyName("updatedAt")] public string UpdatedAt { get; set; } = "";
        [JsonPropertyName("secrets")] public Dictionary<string, string>? Secrets { get; set; }
    }
}
