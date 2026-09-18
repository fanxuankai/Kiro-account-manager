# AGENTS.md — 打包发布

应用代码在 `Kiro-account-manager/` 子目录。

## 打包

```bash
# 1. bump 版本号(改 Kiro-account-manager/package.json 的 version),commit + push
# 2. 触发构建(必须 -R,否则会指向上游 fork):
gh workflow run build-release.yml -R fanxuankai/Kiro-account-manager
```

约 6 分钟跑完,自动建 `v{版本}` **草稿** Release。

## 发布

草稿不算发布,要手动:

```bash
gh release edit v{版本} -R fanxuankai/Kiro-account-manager --draft=false --latest
```

注意:同版本重跑构建会因草稿已存在而失败,先 `gh release delete v{版本} --yes` 删旧草稿再触发。
