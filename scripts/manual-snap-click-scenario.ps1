<#
.SYNOPSIS
    The real-machine scenario for the cua_snap_click tool.
.DESCRIPTION
    Starts two real WinForms windows and prints the coordinates of the points
    the four scenarios need:

      button   the button of the target window: clicking it changes the window
      static   a label of the target window: clicking it changes nothing
      hover    a panel that repaints on hover but does nothing when clicked
      paint    a button that repaints the pixels right at the point
      far      a panel that changes a label far away in the same window
      covered  a point that lies under the cover window

    The geometry is also written as JSON (default: %TEMP%\snap-click-geometry.json)
    so scripts/manual-snap-click-run.mjs can drive the same points.
.EXAMPLE
    powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/manual-snap-click-scenario.ps1
#>
param([string]$GeometryPath = (Join-Path $env:TEMP 'snap-click-geometry.json'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)

$target = New-Object System.Windows.Forms.Form
$target.Text = '目标窗口'
$target.StartPosition = 'Manual'
$target.Location = New-Object System.Drawing.Point(200, 180)
$target.Size = New-Object System.Drawing.Size(560, 460)
$target.TopMost = $true
$target.BackColor = [System.Drawing.Color]::White

$button = New-Object System.Windows.Forms.Button
$button.Text = '改变'
$button.Location = New-Object System.Drawing.Point(30, 30)
$button.Size = New-Object System.Drawing.Size(160, 44)
$button.Font = $font

$paint = New-Object System.Windows.Forms.Button
$paint.Text = '变色'
$paint.Location = New-Object System.Drawing.Point(30, 262)
$paint.Size = New-Object System.Drawing.Size(160, 44)
$paint.Font = $font
$paint.BackColor = [System.Drawing.Color]::White

$far = New-Object System.Windows.Forms.Panel
$far.Location = New-Object System.Drawing.Point(380, 30)
$far.Size = New-Object System.Drawing.Size(160, 44)
$far.BackColor = [System.Drawing.Color]::Gainsboro
$farText = New-Object System.Windows.Forms.Label
$farText.Text = '远处生效'
$farText.Dock = 'Fill'
$farText.TextAlign = 'MiddleCenter'
$far.Controls.Add($farText)

$counter = New-Object System.Windows.Forms.Label
$counter.Text = '还没点'
$counter.Location = New-Object System.Drawing.Point(30, 95)
$counter.AutoSize = $true
$counter.Font = $font

$static = New-Object System.Windows.Forms.Label
$static.Text = '这里是静态文字，点它什么也不会发生'
$static.Location = New-Object System.Drawing.Point(30, 140)
$static.AutoSize = $true
$static.Font = $font

$hover = New-Object System.Windows.Forms.Panel
$hover.Location = New-Object System.Drawing.Point(30, 190)
$hover.Size = New-Object System.Drawing.Size(300, 60)
$hover.BackColor = [System.Drawing.Color]::LightGray
$hoverText = New-Object System.Windows.Forms.Label
$hoverText.Text = '悬停会变色，点击没反应'
$hoverText.Dock = 'Fill'
$hoverText.TextAlign = 'MiddleCenter'
$hover.Controls.Add($hoverText)

$dupA = New-Object System.Windows.Forms.Button
$dupA.Text = '同名'
$dupA.Location = New-Object System.Drawing.Point(30, 320)
$dupA.Size = New-Object System.Drawing.Size(90, 40)
$dupA.Font = $font

$dupB = New-Object System.Windows.Forms.Button
$dupB.Text = '同名'
$dupB.Location = New-Object System.Drawing.Point(135, 320)
$dupB.Size = New-Object System.Drawing.Size(85, 40)
$dupB.Font = $font

$chainOne = New-Object System.Windows.Forms.Button
$chainOne.Text = '链一'
$chainOne.Location = New-Object System.Drawing.Point(30, 370)
$chainOne.Size = New-Object System.Drawing.Size(90, 40)
$chainOne.Font = $font

$chainTwo = New-Object System.Windows.Forms.Button
$chainTwo.Text = '链二'
$chainTwo.Location = New-Object System.Drawing.Point(135, 370)
$chainTwo.Size = New-Object System.Drawing.Size(85, 40)
$chainTwo.Font = $font

$chainThree = New-Object System.Windows.Forms.Button
$chainThree.Text = '链三'
$chainThree.Location = New-Object System.Drawing.Point(30, 415)
$chainThree.Size = New-Object System.Drawing.Size(90, 40)
$chainThree.Font = $font

$clicks = 0
$button.Add_Click({
  $script:clicks = $script:clicks + 1
  $counter.Text = '点过了 ' + $script:clicks
  $target.Refresh()
})
$far.Add_Click({
  $script:clicks = $script:clicks + 1
  $counter.Text = '远处点过了 ' + $script:clicks
  $target.Refresh()
})
$farText.Add_Click({
  $script:clicks = $script:clicks + 1
  $counter.Text = '远处点过了 ' + $script:clicks
  $target.Refresh()
})
$chainOne.Add_Click({ $counter.Text = '链一'; $target.Refresh() })
$chainTwo.Add_Click({ $counter.Text = '链二'; $target.Refresh() })
$chainThree.Add_Click({ $counter.Text = '链三'; $target.Refresh() })
$paint.Add_Click({
  if ($paint.BackColor -eq [System.Drawing.Color]::White) { $paint.BackColor = [System.Drawing.Color]::LightGreen }
  else { $paint.BackColor = [System.Drawing.Color]::White }
  $paint.Refresh()
})
$hover.Add_MouseEnter({ $hover.BackColor = [System.Drawing.Color]::Orange; $hover.Refresh() })
$hover.Add_MouseLeave({ $hover.BackColor = [System.Drawing.Color]::LightGray; $hover.Refresh() })

$target.Controls.Add($button)
$target.Controls.Add($counter)
$target.Controls.Add($static)
$target.Controls.Add($hover)
$target.Controls.Add($paint)
$target.Controls.Add($far)
$target.Controls.Add($dupA)
$target.Controls.Add($dupB)
$target.Controls.Add($chainOne)
$target.Controls.Add($chainTwo)
$target.Controls.Add($chainThree)

$cover = New-Object System.Windows.Forms.Form
$cover.Text = '遮挡窗口'
$cover.StartPosition = 'Manual'
$cover.Location = New-Object System.Drawing.Point(430, 340)
$cover.Size = New-Object System.Drawing.Size(420, 300)
$cover.TopMost = $true
$cover.BackColor = [System.Drawing.Color]::LightSteelBlue
$coverLabel = New-Object System.Windows.Forms.Label
$coverLabel.Text = '我挡住了下面的窗口'
$coverLabel.Location = New-Object System.Drawing.Point(20, 20)
$coverLabel.AutoSize = $true
$coverLabel.Font = $font
$cover.Controls.Add($coverLabel)
$cover.Owner = $target

$target.Show()
$cover.Show()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 700

$buttonPoint = $button.PointToScreen([System.Drawing.Point]::Empty)
$staticPoint = $static.PointToScreen([System.Drawing.Point]::Empty)
$hoverPoint = $hover.PointToScreen([System.Drawing.Point]::Empty)
$paintPoint = $paint.PointToScreen([System.Drawing.Point]::Empty)
$farPoint = $far.PointToScreen([System.Drawing.Point]::Empty)
$targetClient = $target.PointToScreen([System.Drawing.Point]::Empty)
$coverClient = $cover.PointToScreen([System.Drawing.Point]::Empty)

$left = [Math]::Max($targetClient.X, $coverClient.X)
$top = [Math]::Max($targetClient.Y, $coverClient.Y)
$right = [Math]::Min($targetClient.X + $target.ClientSize.Width, $coverClient.X + $cover.ClientSize.Width)
$bottom = [Math]::Min($targetClient.Y + $target.ClientSize.Height, $coverClient.Y + $cover.ClientSize.Height)
$covered = @{ x = [int](($left + $right) / 2); y = [int](($top + $bottom) / 2) }

$geometry = @{
  targetTitle = $target.Text
  coverTitle = $cover.Text
  button = @{ x = $buttonPoint.X + 12; y = $buttonPoint.Y + 12 }
  static = @{ x = $staticPoint.X + 6; y = $staticPoint.Y + 6 }
  hover = @{ x = $hoverPoint.X + 20; y = $hoverPoint.Y + 20 }
  paint = @{ x = $paintPoint.X + 12; y = $paintPoint.Y + 12 }
  far = @{ x = $farPoint.X + 12; y = $farPoint.Y + 12 }
  namedTargets = @{ duplicate = '同名'; chain = @('链一', '链二', '链三') }
  covered = $covered
  targetClient = @{ x = $targetClient.X; y = $targetClient.Y; width = $target.ClientSize.Width; height = $target.ClientSize.Height }
  coverClient = @{ x = $coverClient.X; y = $coverClient.Y; width = $cover.ClientSize.Width; height = $cover.ClientSize.Height }
}
[System.IO.File]::WriteAllText($GeometryPath, ($geometry | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))

Write-Output ('geometry written to ' + $GeometryPath)
Write-Output ('  button  ({0}, {1})  改变：点了界面会变' -f $geometry.button.x, $geometry.button.y)
Write-Output ('  static  ({0}, {1})  静态文字：点了什么也不会发生' -f $geometry.static.x, $geometry.static.y)
Write-Output ('  hover   ({0}, {1})  悬停变色、点击无效' -f $geometry.hover.x, $geometry.hover.y)
Write-Output ('  paint   ({0}, {1})  变色按钮：点它，落点附近的像素立刻变了' -f $geometry.paint.x, $geometry.paint.y)
Write-Output ('  far     ({0}, {1})  远处生效：点它，自己没变，但窗口别处变了' -f $geometry.far.x, $geometry.far.y)
Write-Output ('  covered ({0}, {1})  被遮挡窗口盖住的点' -f $geometry.covered.x, $geometry.covered.y)
Write-Output 'close both windows to end the scenario'

[System.Windows.Forms.Application]::Run($target)
