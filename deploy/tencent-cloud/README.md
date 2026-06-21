# 腾讯云部署指南

适用于腾讯云轻量应用服务器或 CVM。推荐使用 Ubuntu 22.04/24.04，Node.js 20，Nginx 反向代理，systemd 常驻运行。

## 一、腾讯云控制台准备

1. 创建一台轻量应用服务器或 CVM。
2. 系统选择 Ubuntu。
3. 防火墙/安全组只开放：
   - `22`：SSH
   - `80`：HTTP
   - `443`：HTTPS
4. 不建议公网开放 `3000`。应用监听本机 `127.0.0.1:3000`，由 Nginx 转发。

如果使用腾讯云控制台的“源码构建 / 容器镜像构建”方式，仓库根目录已提供 `Dockerfile`。构建配置选择：

- Dockerfile 路径：`Dockerfile`
- 构建上下文：`.`
- 服务端口：`3000`
- 启动命令：留空，使用 Dockerfile 默认 `CMD`

容器部署时不要设置 `HOST=127.0.0.1`，否则容器外部无法访问服务。只在 CVM + Nginx 手动部署时使用 `HOST=127.0.0.1`。

容器方式需要在腾讯云环境变量里填写 `DEEPSEEK_API_KEY`、固定的 `SESSION_SECRET`，并按需要设置 `ALLOW_REGISTRATION`；不要填写真实 `.env` 文件，也不要把 API Key 写进 Dockerfile。

## 二、服务器安装基础环境

```bash
sudo apt update
sudo apt install -y git curl nginx ca-certificates

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node -v
npm -v
```

## 三、拉取代码

仓库是 Private 时，服务器需要有 GitHub 访问权限。推荐使用 GitHub Deploy Key，或者临时用 HTTPS token 克隆。不要把 token 写进仓库。

```bash
cd /opt
sudo git clone https://github.com/Alia0415/resume-assistant.git
sudo chown -R $USER:$USER /opt/resume-assistant
cd /opt/resume-assistant/server
npm ci
```

## 四、配置环境变量

```bash
cd /opt/resume-assistant/server
cp .env.example .env
nano .env
```

至少填写：

```env
DEEPSEEK_API_KEY=你的真实DeepSeekKey
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_MODEL_PRO=deepseek-v4-pro
PORT=3000
HOST=127.0.0.1
SESSION_SECRET=替换为随机长字符串
ALLOW_REGISTRATION=true
```

`.env` 只能保存在服务器本地，不能提交到 GitHub。

生成 `SESSION_SECRET`：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

首次部署后先注册自己的账号；账号创建完成后，建议把 `ALLOW_REGISTRATION=false` 并重启服务，避免公网用户自行注册。

## 五、配置 systemd

复制服务模板：

```bash
sudo cp /opt/resume-assistant/deploy/tencent-cloud/resume-assistant.service /etc/systemd/system/resume-assistant.service
sudo systemctl daemon-reload
sudo systemctl enable resume-assistant
sudo systemctl start resume-assistant
sudo systemctl status resume-assistant
```

查看日志：

```bash
journalctl -u resume-assistant -f
```

本机验证：

```bash
curl http://127.0.0.1:3000/api/health
```

## 六、配置 Nginx

把 `nginx-resume-assistant.conf` 里的 `example.com` 改成你的域名。

```bash
sudo cp /opt/resume-assistant/deploy/tencent-cloud/nginx-resume-assistant.conf /etc/nginx/sites-available/resume-assistant
sudo nano /etc/nginx/sites-available/resume-assistant
sudo ln -s /etc/nginx/sites-available/resume-assistant /etc/nginx/sites-enabled/resume-assistant
sudo nginx -t
sudo systemctl reload nginx
```

访问：

```text
http://你的域名/求职管家.dc.html
```

## 七、HTTPS

域名解析到服务器公网 IP 后，可安装 Certbot：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

## 八、更新部署

```bash
cd /opt/resume-assistant
git pull
cd server
npm ci
sudo systemctl restart resume-assistant
sudo systemctl reload nginx
```

## 九、安全检查

- 不要开放 `3000` 到公网。
- 不要提交 `server/.env`。
- 公网必须配置固定的 `SESSION_SECRET`，并在创建好账号后关闭注册。
- 腾讯云安全组/防火墙只开放 `22`、`80`、`443`。
- API Key 只放在服务器 `/opt/resume-assistant/server/.env` 或腾讯云环境变量中。

## 十、常见报错

### `401 Authentication Fails, Your api key ... is invalid`

这表示请求已经到达 DeepSeek，但 `DEEPSEEK_API_KEY` 无效。请在腾讯云环境变量里重新填写：

```text
DEEPSEEK_API_KEY=你的真实 DeepSeek API Key
```

注意：

- 不要填变量名本身，例如不要把 value 写成 `DEEPSEEK_API_KEY`。
- 不要填示例、占位符或被星号隐藏后的 key。
- 不要加引号。
- 不要开启腾讯云页面里的“API key 设置”开关；那里是腾讯云自己的 Key，不是 DeepSeek Key。
- 如果不确定原来的 Key 是否可用，去 DeepSeek 控制台新建一个 API Key，再复制完整值到腾讯云环境变量。
- 改完环境变量后必须重新部署或重启服务。

## 参考文档

- 腾讯云 CVM：手动搭建 Node.js 环境
  https://cloud.tencent.com/document/product/213/38237
- 腾讯云轻量应用服务器：搭建 Node.js 开发环境
  https://cloud.tencent.com/document/product/1207/60266
- 腾讯云轻量应用服务器：管理实例防火墙
  https://cloud.tencent.com/document/product/1207/44577
- 腾讯云 CVM：添加安全组规则
  https://cloud.tencent.com/document/product/213/112614
