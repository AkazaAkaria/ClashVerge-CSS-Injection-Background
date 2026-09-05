# Clash Verge Rev Glass Theme

一套为 Clash Verge Rev 制作的透明磨砂玻璃 CSS 主题，内置背景壁纸。

> 本主题按 **Clash Verge Rev v2.5.2** 制作和测试，**深色主题下效果最佳**。不建议在浅色主题下使用。

## 安装

1. 打开 Clash Verge Rev，进入“设置 → Verge 基础设置 → 主题设置 → CSS 注入”。
2. 将“主题模式”切换为“深色”。
3. 打开 CSS 注入编辑器，按 `Ctrl+A` 全选并删除旧内容，再粘贴 css 的全部内容。
4. 保存 CSS 编辑器，再保存主题设置。
5. 如果界面没有立即刷新，重启 Clash Verge Rev。

## 推荐颜色

下面这套配色是根据仓库当前附带的蓝灰、粉色壁纸选择的，目的是让按钮强调色与壁纸呼应，并保证深色模式下的文字和状态颜色清楚。它不是所有壁纸的通用最优解；更换壁纸后，可以优先调整主色、次色和信息色，成功、警告、错误色建议继续保持明确的语义区分。

```text
主色: #5AB0F8
次色: #F58BA6
主文字色: #FFFFFF
次文字色: #EBEBF599
信息色: #7FC8FF
警告色: #F5B45C
错误色: #FF6B80
成功色: #3FD3A8
```

## 更换背景图

### 使用仓库附带的在线壁纸

也可以直接改成其他图片直链：

```css
--cv-wallpaper: url("https://example.com/wallpaper.jpg");
```

### 使用自己的本地图片

本地图片不会依赖网络。推荐先将图片复制到一个路径简单、不会随意移动的位置，例如：

```text
C:\Users\Public\Pictures\ClashVergeTheme\wallpaper.jpg
```

然后打开 Clash Verge Rev 的 CSS 注入编辑器，找到文件顶部的 `--cv-wallpaper`，替换为：

```css
--cv-wallpaper: url("http://asset.localhost/C%3A%5CUsers%5CPublic%5CPictures%5CClashVergeTheme%5Cwallpaper.jpg");
```

保存 CSS 编辑器和外层主题设置；如果没有立即刷新，重启 Clash Verge Rev。

不能把 `C:\...` 或 `D:\...` 这样的 Windows 原始路径直接放进 `url()`。如果要使用其他路径，可在 PowerShell 中执行：

```powershell
$picturePath = 'D:\下载\壁纸.jpg'
'http://asset.localhost/' + [uri]::EscapeDataString($picturePath)
```

将输出的完整地址复制到：

```css
--cv-wallpaper: url("这里粘贴 PowerShell 输出的地址");
```

### 调整新壁纸的明暗

背景太亮或太暗时，调整 `css` 顶部的遮罩透明度：

```css
--cv-scrim: rgba(6, 8, 14, 0.50);
```

最后一个数值越大，背景越暗；越小，背景越亮。

- 明亮、细节复杂的壁纸可以从 `0.55` 到 `0.65` 尝试。
- 较暗、主体简单的壁纸可以从 `0.35` 到 `0.50` 尝试。
- 需要轻微降低亮度或饱和度时，可调整 `--cv-wp-filter`，例如 `brightness(0.90) saturate(0.95)`。

## 兼容性

- 已针对 Clash Verge Rev v2.5.2 深色模式检查。
- 主题依赖当前版本的页面结构和 Chromium `:has()` 选择器。
- Clash Verge Rev 升级后若页面结构变化，个别组件可能需要重新适配。
- 本项目不是 Clash Verge Rev 官方主题。
