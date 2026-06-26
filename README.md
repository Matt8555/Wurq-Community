# Wurq Community Demo

A minimal, deploy-ready static demo app served by a small Express server.
Static assets live in `public/`, and the server serves `index.html` for any
unmatched route.

## Local development

```bash
npm install
npm start
```

The server binds to `process.env.PORT || 3000`. Once running, open
[http://localhost:3000](http://localhost:3000).

## Deploy to Railway

This repo is configured for [Railway](https://railway.app) using the Nixpacks
builder (see `railway.json`).

1. Create a new Railway project and connect this GitHub repository.
2. Railway auto-detects the Node app and builds it with Nixpacks.
3. The app starts with `npm start` and listens on the `PORT` Railway provides.

No extra environment variables are required for the demo.
