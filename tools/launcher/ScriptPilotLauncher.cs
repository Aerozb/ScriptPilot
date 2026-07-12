using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

internal static class ScriptPilotLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string appDir = Path.Combine(baseDir, "app");
        string targetExe = Path.Combine(appDir, "ScriptPilot.exe");

        if (!File.Exists(targetExe))
        {
            MessageBox.Show(
                "ScriptPilot app files were not found. Please keep ScriptPilot.exe and the app folder together.",
                "ScriptPilot",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return 1;
        }

        try
        {
            ProcessStartInfo startInfo = new ProcessStartInfo
            {
                FileName = targetExe,
                WorkingDirectory = appDir,
                Arguments = JoinArguments(args),
                UseShellExecute = true
            };
            Process.Start(startInfo);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "ScriptPilot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string JoinArguments(string[] args)
    {
        if (args == null || args.Length == 0)
        {
            return string.Empty;
        }

        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < args.Length; i += 1)
        {
            if (i > 0)
            {
                builder.Append(' ');
            }
            builder.Append(QuoteArgument(args[i]));
        }
        return builder.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "\"\"";
        }

        bool needsQuotes = value.IndexOfAny(new[] { ' ', '\t', '\n', '\r', '"' }) >= 0;
        if (!needsQuotes)
        {
            return value;
        }

        StringBuilder builder = new StringBuilder();
        builder.Append('"');
        int backslashes = 0;

        foreach (char current in value)
        {
            if (current == '\\')
            {
                backslashes += 1;
                continue;
            }

            if (current == '"')
            {
                builder.Append('\\', backslashes * 2 + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }

            if (backslashes > 0)
            {
                builder.Append('\\', backslashes);
                backslashes = 0;
            }
            builder.Append(current);
        }

        if (backslashes > 0)
        {
            builder.Append('\\', backslashes * 2);
        }
        builder.Append('"');
        return builder.ToString();
    }
}
