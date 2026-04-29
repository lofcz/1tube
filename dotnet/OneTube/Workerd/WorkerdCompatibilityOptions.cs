namespace OneTube.Workerd;

/// <summary>
/// File-backed runtime editor for workerd compatibility settings.
/// Requires firmware because applying a change is a side-by-side
/// gateway swap, same as live secrets.
/// </summary>
public sealed class WorkerdCompatibilityOptions
{
    public bool Enabled { get; set; } = true;
    public string? Path { get; set; }
    public string RoutePrefix { get; set; } = "/1tube/api";
    public int ReloadDebounceMs { get; set; } = 500;
}
