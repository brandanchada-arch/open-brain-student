# Installs the Friday suggestion on this PC. Read it first, then run it yourself from the repo folder:
#   powershell -ExecutionPolicy Bypass -File pc-setup\install-friday-suggestion.ps1
# It copies the scripts to %USERPROFILE%\.open-brain\scripts and adds one Windows scheduled task.
# It holds no keys: the script reads them from %USERPROFILE%\.open-brain\.env.
#
# Undo: Unregister-ScheduledTask "Open Brain Friday suggestion" -Confirm:$false
# Or leave it installed and add FRIDAY_SUGGESTION=off to %USERPROFILE%\.open-brain\.env

$target = "$env:USERPROFILE\.open-brain\scripts"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force "$PSScriptRoot\scripts\*" $target

$node = (Get-Command node).Source
$script = "$target\friday-suggestion.js"
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At 3pm
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Open Brain Friday suggestion" -Action $action -Trigger $trigger -Settings $settings -Description "One suggestion a week about projects or the brain. Changes nothing by itself." -Force | Out-Null

Write-Output "Installed. It next runs on Friday at 3 PM, or as soon as the PC is on after that."
