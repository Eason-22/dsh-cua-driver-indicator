# The native half of the cua_snap_click tool.
#
# It compiles windows-snap-click.cs once and then answers the requests of the
# tool: one JSON object per line on stdin, one answer per line on stdout. The
# process stays alive until the tool says stop, so a click does not pay the
# start-up cost of PowerShell every time.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions
  # The UI Automation assemblies are referenced by the C# below, so they have to
  # be loaded before the compilation happens: a machine without them cannot run
  # this helper any more, and that is visible right here.
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
  $source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-snap-click.cs'), [Text.Encoding]::UTF8)
  Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions,UIAutomationClient,UIAutomationTypes,WindowsBase
  [DshSnapClick.Host]::Run()
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
