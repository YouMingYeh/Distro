# Distro video model server

One HTTP endpoint in front of every GMI Cloud video model. Deployed on Cloud Run at
`https://distro-model-417048709195.asia-east1.run.app`.

How to call it, choose a model, and operate the deployment: **[docs/MODEL_SERVER.md](../docs/MODEL_SERVER.md)**.

Run locally:

```bash
uv run model_server/app.py   # http://localhost:8787
```
