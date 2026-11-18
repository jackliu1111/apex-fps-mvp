# 腾讯云更新记录：2026-11-17

从本机通过 `ssh cloud-server` 完成部署。目标 `root@140.143.223.69`，代码目录 `/opt/apex-fps-mvp`，systemd 服务 `apex-fps-mvp.service`，公网入口 https://140.143.223.69:8443/ 。

版本从 `76a6cf9` 快进至 `388dccc`。使用本机 Git bundle 传输已提交版本；工作区未提交的文档未部署。保留 `/srv/apex-fps-mvp/assets` 与现有 Nginx、TLS、systemd 配置。服务通过 `/etc/apex-fps-mvp/server.py` 启动，首页覆盖文件 `/etc/apex-fps-mvp/index.html` 已同步为新版仓库首页；当前代码固定使用 EfficientAT。

验证：本机 91 项 Node 测试全部通过；重启后静态服务及 Nginx 均 active；公网 HTTPS 返回的 26 个 HTML/JS/CSS 文件 SHA-256 与本机一致；7 个运行库及模型资源 HEAD 均成功。本轮未运行浏览器真实录像分析和导出验收。

回滚备份：`/srv/apex-fps-mvp/deploy-backups/20261117-388dccc/`，含原 commit、首页、启动脚本与 systemd 配置。

回滚命令（在服务器执行）：

```sh
cd /opt/apex-fps-mvp
# 执行前确认线上没有新增修改。
git status --short
git switch --detach "$(cat /srv/apex-fps-mvp/deploy-backups/20261117-388dccc/previous-commit)"
cp /srv/apex-fps-mvp/deploy-backups/20261117-388dccc/index.html /etc/apex-fps-mvp/index.html
systemctl restart apex-fps-mvp.service
systemctl is-active apex-fps-mvp.service nginx
```

本机 SSH 配置已增加 `cloud-server`，使用 `~/.ssh/mac_pro.pem`，文件权限 600；原配置已备份至 `~/.ssh/config.backup-cloud-server-20261117-113518`。私钥未写入项目仓库。
