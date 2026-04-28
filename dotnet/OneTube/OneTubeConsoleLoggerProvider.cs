using Microsoft.Extensions.Logging;

namespace OneTube;

internal sealed class OneTubeConsoleLoggerProvider : ILoggerProvider
{
    private static readonly HashSet<string> Categories = new(StringComparer.Ordinal)
    {
        typeof(DenoHostService).FullName!,
        "OneTube.Proxy",
    };

    public ILogger CreateLogger(string categoryName)
        => Categories.Contains(categoryName)
            ? new OneTubeConsoleLogger(enabled: true)
            : new OneTubeConsoleLogger(enabled: false);

    public void Dispose()
    {
    }

    private sealed class OneTubeConsoleLogger : ILogger
    {
        private readonly bool _enabled;

        public OneTubeConsoleLogger(bool enabled)
        {
            _enabled = enabled;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => _enabled && logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;

            var message = formatter(state, exception);
            if (string.IsNullOrWhiteSpace(message) && exception is null) return;

            var line = string.IsNullOrWhiteSpace(message)
                ? exception!.Message
                : message;
            line = line.ReplaceLineEndings(" ");

            if (exception is not null)
            {
                line += " " + exception.GetType().Name + ": " + exception.Message;
            }

            var writer = logLevel >= LogLevel.Warning ? Console.Error : Console.Out;
            writer.WriteLine(line);
        }
    }
}
