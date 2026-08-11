搭饭小馆 Windows 本地版

1. 双击 start.bat 启动，浏览器会打开 http://127.0.0.1:8787。
2. 手机与电脑连接同一 Wi-Fi 后，可使用启动窗口显示的局域网地址访问。
3. Windows 防火墙如提示，请仅允许家庭/专用网络访问 8787 端口。
4. 双击 stop.bat 停止。脚本只会停止 data\app.pid 记录且命令行匹配本应用的进程，不会结束其他 node.exe。
5. 数据保存在 data\app.db，图片保存在 data\uploads，请勿在服务运行时手工替换。
6. 可在“设置 → 备份与恢复”导出或恢复完整 ZIP。

正式分发包必须同时包含 runtime\node.exe、本地生产依赖、Prisma CLI 与迁移文件；启动和迁移均不依赖系统 npm。开发包未附带 runtime\node.exe 时，需要 Node.js 22+。
