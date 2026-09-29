# Visual Freeze 基线

- 分支：`integration/google2-backend`；验收 HEAD：`ea8e87b3`。
- 捕获方式：Playwright + 本机 Chrome headless，未修改源 HTML；drawer 通过页面公开函数 `toggleDrawer(true)` 打开，modal 通过页面公开函数 `BentoModal.open('recordForm')` 打开，并在截图前读取 computed style、class 与 bounding box 断言可见。
- 源文件事实来自 `source-snapshot.json`：三个 HTML 均为 490029 bytes，SHA-256 均为 `0c6f65473399a4ea0a708495b40cdd8f606b252dcb32055b0032d53596180f16`，mtime 为 `2026-09-23T10:57:54.1070656Z`。
- 所有 PNG 均已写入且非空；manifest 中 bytes、SHA-256、PNG width/height 已按实际磁盘文件复核。

| 文件 | 预期状态 | viewport | 主题 |
|---|---|---:|---|
| home-light.png | Home | 1440x900 | light |
| home-dark.png | Home | 1440x900 | dark |
| recommendations-light.png | Recommendations | 1440x900 | light |
| recommendations-dark.png | Recommendations | 1440x900 | dark |
| mobile-drawer.png | mobile drawer（drawerVisible=true） | 390x844 | light |
| mobile-dock.png | mobile dock | 390x844 | light |
| modal.png | modal（dialogVisible=true，id=`modalRecordForm`） | 1440x900 | light |
| mobile-dark.png | mobile Home | 390x844 | dark |

`mobile-drawer.png` 与 `mobile-dock.png` 的实际 SHA-256 不同；drawer 证据为 `#mobileDrawerRoot`、`display:flex`、可见 class、非零几何尺寸。modal 证据为 `#modalRecordForm`、`display:flex`、`body.modal-open`、1440x900 overlay 几何尺寸。