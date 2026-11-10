# Installs the automatic backup for session summaries. Run it yourself from the repo folder:
#   powershell -ExecutionPolicy Bypass -File pc-setup\install-session-sweep.ps1
# It copies the scripts to %USERPROFILE%\.open-brain\scripts and adds one Windows scheduled task
# that runs once an hour. It holds no keys: the scripts read them from %USERPROFILE%\.open-brain\.env.
#
# Undo: Unregister-ScheduledTask "Open Brain session sweep" -Confirm:$false
# Or leave it installed and add SESSION_SWEEP=off to %USERPROFILE%\.open-brain\.env

$target = "$env:USERPROFILE\.open-brain\scripts"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force "$PSScriptRoot\scripts\*" $target

$node = (Get-Command node).Source
$script = "$target\session-sweep.js"
# Run with no console window. A task that starts node.exe directly gets a console, and closing it or a
# stray Ctrl+C kills the run (exit code 3221225786). conhost always reports 0 to Task Scheduler,
# so check claude-session-logs\.sweep-runs.log: a "start" with no "end" means a run was killed.
$conhost = "$env:SystemRoot\System32\conhost.exe"
$action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$node`" `"$script`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Open Brain session sweep" -Action $action -Trigger $trigger -Settings $settings -Description "Summarizes Claude Code sessions that have gone quiet, one at a time." -Force | Out-Null

Write-Output "Installed. It first runs in about 5 minutes, then once an hour while the PC is on."
