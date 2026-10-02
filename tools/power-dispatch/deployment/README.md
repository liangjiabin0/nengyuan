# Deployment

开发环境可直接运行 FastAPI。生产环境建议把 API 与求解 Worker 分离；本 Dockerfile 只是单容器参考入口。

```bash
docker compose -f deployment/docker-compose.yml up --build
```

商业求解器许可证、API Key、工程数据库凭据不得写入镜像或 Skill 包。
