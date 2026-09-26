# DJ Tools

Reusable browser-based tools that run locally on the user's device.

## Tools

### Image to WebGL

Convert transparent PNG artwork into a textured, extruded 3D object, preview it
interactively with Three.js, and download it as a self-contained GLB.

- Use online: [Image to WebGL](https://darrenjohns.github.io/djtools/image-to-webgl/)
- Source: [`apps/image-to-webgl`](./apps/image-to-webgl)
- No image uploads or hosted conversion service
- Adjustable depth, edge width, color blending, and curvature
- Light and dark preview environments

## Contributor setup

The public tools run in the browser and do not require npm. The following commands
are for contributors who want to run or modify the source locally.

Requirements:

- Node.js 22.12 or newer
- npm
- Microsoft Edge for the optional browser smoke test

Install and run the first tool:

```powershell
npm install
npm run dev
```

Validation:

```powershell
npm run typecheck
npm test
npm run build
```

With the development server running in another terminal:

```powershell
npm run test:browser
```

## GitHub Pages

The repository's GitHub Pages workflow publishes the tool catalog and applications
from `main`.

- [DJ Tools catalog](https://darrenjohns.github.io/djtools/)
- [Image to WebGL](https://darrenjohns.github.io/djtools/image-to-webgl/)

## Adding another tool

Add each future application under `apps/` as its own npm workspace, then expose
convenience scripts from the root `package.json`.

## License

[MIT](./LICENSE)
