# my-react-dashboard

## ✅ 项目结构
```

my-react-dashboard/
├─ .github/workflows/
│   └─ deploy.yml
└─ moving-average-demo/
├─ package.json
├─ vite.config.ts
└─ src/...

```

最终访问 URL：
```
https://truezyz.github.io/my-react-dashboard/
````
---

## 1. 设置 Vite 的 `base`
在 `moving-average-demo/vite.config.ts` 中添加：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/my-react-dashboard/' // 仓库名（不是子目录名）
})
````

***

## 2. 创建 GitHub Actions 工作流

在仓库根目录创建文件：  
`.github/workflows/deploy.yml`

内容示例（适配子目录项目）：

```yaml
name: Deploy Vite React to GitHub Pages

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: "moving-average-demo"   # 子目录
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: "moving-average-demo/package-lock.json"

      - name: Install
        run: npm ci

      - name: Build
        run: npm run build

      - name: Configure Pages
        uses: actions/configure-pages@v5

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: "moving-average-demo/dist"

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

***

## 3. 启用 Pages

*   打开仓库 → **Settings → Pages → Build and deployment**
*   选择 **GitHub Actions**

***

## 4. 推送并触发部署

```bash
git add .
git commit -m "setup GitHub Pages deploy workflow"
git push origin main
```

***

## ✅ 验证部署

*   打开 **Actions** → 确认 `build` 和 `deploy` 都是绿色 ✅
*   打开 Pages URL：

<!---->

    https://<你的用户名>.github.io/my-react-dashboard/

***

## ⚠️ 常见问题

| 症状                   | 原因                                | 修复                                 |
| -------------------- | --------------------------------- | ---------------------------------- |
| 页面空白或 404            | `vite.config.ts` 的 `base` 未设置为仓库名 | 设置 `base: '/my-react-dashboard/'`  |
| 静态资源加载失败             | 使用了绝对路径 `/file.csv`               | 改用 `import.meta.env.BASE_URL` 拼接路径 |
| React Router 子路径 404 | Pages 无法处理 SPA 路由                 | 使用 `HashRouter` 替代 `BrowserRouter` |

```

--