namespace OneTube.Firmware;

/// <summary>
/// Centralised disk-path resolver. Every directory and file the
/// firmware system touches goes through this type so the layout
/// can be inspected and changed in one place. The shape is:
///
/// <code>
/// {DataRoot}/onetube/
///   ├── state.json
///   ├── versions/&lt;ver&gt;/
///   │     ├── envelope.json     (copy of the verified envelope)
///   │     └── dist/
///   │           ├── manifest.json
///   │           └── functions/&lt;fn&gt;.js
///   ├── incoming/&lt;jobId&gt;/      (transient; deleted on success or fail)
///   │     ├── payload.zip
///   │     └── unpacked/         (the dist+envelope expanded for verify)
///   └── locks/                   (reserved for cross-process locks; v1 unused)
/// </code>
///
/// Every method is pure path manipulation — no I/O — so the layout
/// is safe to compute in hot paths without touching disk.
/// </summary>
public sealed class FirmwareLayout
{
    public string Root { get; }
    public string StateJsonPath => Path.Combine(Root, "state.json");
    public string VersionsDir => Path.Combine(Root, "versions");
    public string IncomingDir => Path.Combine(Root, "incoming");
    public string LocksDir => Path.Combine(Root, "locks");

    public FirmwareLayout(string dataRoot)
    {
        // {DataRoot}/onetube/ exists so OneTube doesn't squat the
        // entire DataRoot — leaves room for sibling subsystems on the
        // same host (priprava already uses DataRoot for other state).
        Root = Path.Combine(Path.GetFullPath(dataRoot), "onetube");
    }

    public string VersionDir(string version) => Path.Combine(VersionsDir, version);
    public string VersionDistDir(string version) => Path.Combine(VersionDir(version), "dist");
    public string VersionEnvelopePath(string version) => Path.Combine(VersionDir(version), "envelope.json");
    public string IncomingDirFor(string jobId) => Path.Combine(IncomingDir, jobId);
    public string IncomingPayload(string jobId) => Path.Combine(IncomingDirFor(jobId), "payload.zip");
    public string IncomingUnpacked(string jobId) => Path.Combine(IncomingDirFor(jobId), "unpacked");

    public void EnsureDirectories()
    {
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(VersionsDir);
        Directory.CreateDirectory(IncomingDir);
        Directory.CreateDirectory(LocksDir);
    }
}
