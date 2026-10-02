# API 调用示例

## 获取算例

```bash
curl http://localhost:8000/api/cases
```

## 校验

```bash
curl -X POST http://localhost:8000/api/run/validate \
  -H 'Content-Type: application/json' \
  -d '{"spec": { ... }, "dry_run": true}'
```

## 运行

```bash
curl -X POST http://localhost:8000/api/run \
  -H 'Content-Type: application/json' \
  -d '{"spec": { ... }, "dry_run": false}'
```
