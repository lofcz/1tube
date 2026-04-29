using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace OneTube.Workerd;

public sealed class WorkerdCompatibilityStore
{
    private readonly WorkerdCompatibilityOptions _options;
    private readonly OneTubeOptions _oneTube;
    private readonly ILogger<WorkerdCompatibilityStore> _logger;
    private readonly string _absolutePath;
    private readonly object _writeLock = new();
    private WorkerdCompatibilitySettings _settings = WorkerdCompatibilitySettings.Empty;

    public event Action? Changed;

    public WorkerdCompatibilityStore(
        IOptions<WorkerdCompatibilityOptions> options,
        IOptions<OneTubeOptions> oneTube,
        ILogger<WorkerdCompatibilityStore> logger)
    {
        _options = options.Value;
        _oneTube = oneTube.Value;
        _logger = logger;

        if (string.IsNullOrWhiteSpace(_options.Path))
        {
            throw new InvalidOperationException(
                "WorkerdCompatibilityOptions.Path is required. Set it to e.g. " +
                "\"onetube/data/workerd-compatibility.json\" relative to the host's bin/.");
        }

        _absolutePath = Path.IsPathRooted(_options.Path)
            ? _options.Path
            : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, _options.Path));

        var dir = Path.GetDirectoryName(_absolutePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        Load();
        ApplyToOptions(_settings);
    }

    public WorkerdCompatibilitySettings Snapshot() => _settings;

    public bool Replace(WorkerdCompatibilitySettings settings)
    {
        var next = Normalize(settings);
        lock (_writeLock)
        {
            if (SettingsEqual(next, _settings)) return false;
            Persist(next);
            _settings = next;
            ApplyToOptions(next);
        }
        Changed?.Invoke();
        return true;
    }

    public void Reload()
    {
        lock (_writeLock)
        {
            Load();
            ApplyToOptions(_settings);
        }
        Changed?.Invoke();
    }

    private void Load()
    {
        if (!File.Exists(_absolutePath))
        {
            _settings = FromOneTubeOptions();
            return;
        }

        try
        {
            var bytes = File.ReadAllBytes(_absolutePath);
            if (bytes.Length == 0)
            {
                _settings = FromOneTubeOptions();
                return;
            }
            var file = JsonSerializer.Deserialize<WorkerdCompatibilityFile>(bytes, s_jsonOpts);
            _settings = Normalize(new WorkerdCompatibilitySettings(
                CompatibilityDate: file?.CompatibilityDate,
                CompatibilityFlags: file?.CompatibilityFlags ?? [],
                Experimental: file?.Experimental ?? false));
            _logger.LogInformation(
                "[1tube/workerd] loaded compatibility settings from {Path}", _absolutePath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex,
                "[1tube/workerd] failed to read {Path}; falling back to app configuration.",
                _absolutePath);
            _settings = FromOneTubeOptions();
        }
    }

    private WorkerdCompatibilitySettings FromOneTubeOptions() => Normalize(new WorkerdCompatibilitySettings(
        CompatibilityDate: _oneTube.WorkerdCompatibilityDate,
        CompatibilityFlags: _oneTube.WorkerdCompatibilityFlags ?? [],
        Experimental: _oneTube.WorkerdExperimental));

    private void ApplyToOptions(WorkerdCompatibilitySettings settings)
    {
        _oneTube.WorkerdCompatibilityDate = settings.CompatibilityDate;
        _oneTube.WorkerdCompatibilityFlags = settings.CompatibilityFlags;
        _oneTube.WorkerdExperimental = settings.Experimental;
    }

    private void Persist(WorkerdCompatibilitySettings settings)
    {
        var file = new WorkerdCompatibilityFile
        {
            SchemaVersion = 1,
            UpdatedAt = DateTime.UtcNow.ToString("O"),
            CompatibilityDate = settings.CompatibilityDate,
            CompatibilityFlags = settings.CompatibilityFlags.ToArray(),
            Experimental = settings.Experimental,
        };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(file, s_jsonOpts);
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

    private static WorkerdCompatibilitySettings Normalize(WorkerdCompatibilitySettings settings)
    {
        var date = string.IsNullOrWhiteSpace(settings.CompatibilityDate)
            ? null
            : settings.CompatibilityDate.Trim();
        if (date is not null && !s_dateRe.IsMatch(date))
        {
            throw new ArgumentException("compatibility date must use yyyy-MM-dd format");
        }

        var flags = settings.CompatibilityFlags
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToImmutableArray();
        foreach (var flag in flags)
        {
            if (!s_flagRe.IsMatch(flag))
            {
                throw new ArgumentException(
                    $"compatibility flag '{flag}' is invalid ([A-Za-z0-9_:-]+)");
            }
        }

        return new WorkerdCompatibilitySettings(date, flags, settings.Experimental);
    }

    private static bool SettingsEqual(WorkerdCompatibilitySettings a, WorkerdCompatibilitySettings b)
        => string.Equals(a.CompatibilityDate, b.CompatibilityDate, StringComparison.Ordinal)
           && a.Experimental == b.Experimental
           && a.CompatibilityFlags.SequenceEqual(b.CompatibilityFlags, StringComparer.Ordinal);

    private static readonly JsonSerializerOptions s_jsonOpts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = true,
    };

    private static readonly Regex s_dateRe = new(@"^\d{4}-\d{2}-\d{2}$", RegexOptions.Compiled);
    private static readonly Regex s_flagRe = new(@"^[A-Za-z0-9_:-]+$", RegexOptions.Compiled);

    private sealed class WorkerdCompatibilityFile
    {
        [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; set; }
        [JsonPropertyName("updatedAt")] public string UpdatedAt { get; set; } = "";
        [JsonPropertyName("compatibilityDate")] public string? CompatibilityDate { get; set; }
        [JsonPropertyName("compatibilityFlags")] public string[]? CompatibilityFlags { get; set; }
        [JsonPropertyName("experimental")] public bool Experimental { get; set; }
    }
}

public sealed record WorkerdCompatibilitySettings(
    string? CompatibilityDate,
    IReadOnlyList<string> CompatibilityFlags,
    bool Experimental)
{
    public static WorkerdCompatibilitySettings Empty { get; } = new(null, [], false);
}
