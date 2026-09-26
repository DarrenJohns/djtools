# Image to WebGL

Convert transparent PNG artwork into a textured, extruded 3D object directly in
your browser. Preview the result interactively and download it as a self-contained
GLB file.

## Use online

[Open Image to WebGL](https://darrenjohns.github.io/djtools/image-to-webgl/)

No installation, account, or image upload is required. Conversion runs locally on
your device.

## How to use it

1. Open or drop a transparent PNG into the upload area.
2. Adjust the object settings:
   - **Extrusion depth** controls the overall thickness.
   - **Edge width** controls the size of the bevel.
   - **Edge curve** changes the bevel from angular to smoothly rounded.
   - **Color blend** softens color transitions around the bevel and sides without
     blurring the original front and rear artwork.
3. Drag to orbit, scroll to zoom, or right-drag to pan the generated object.
4. Use the sun/moon switch to inspect it in light and dark environments.
5. Select **Download GLB** to save the generated 3D asset.

The preview reloads the generated GLB, so it represents the file that will be
downloaded. The status beside the Download button reports the contour count,
triangle count, and GLB file size.

## What it creates

Image to WebGL traces the PNG's transparent silhouette and turns it into shallow
3D geometry:

- Transparent holes remain holes in the mesh.
- Disconnected visible regions become separate solids in the same GLB.
- The original artwork is preserved on the front and rear faces.
- Projected source colors continue around the bevel and sides.
- Planar face normals keep flat artwork evenly lit while bevels remain smooth.

This is deterministic 2.5D extrusion, not AI-based single-image reconstruction.
It does not infer hidden surfaces from photographs.

## Supported input

- PNG format
- A transparent background that reaches the outside image boundary
- Visible artwork suitable for silhouette-based extrusion
- Up to 20 MB
- Up to 8192 pixels per side and 25 megapixels

The app reports an explicit error for invalid files, fully transparent images,
fully opaque images, oversized images, and artwork without a traceable silhouette.
JPEG background removal is not currently included.

## Developer setup

The following npm commands are only for contributors who want to run or modify the
source code. They are not required to use the online tool.

Requirements:

- Node.js 22.12 or newer
- npm
- Microsoft Edge for the browser smoke test

From the repository root:

```powershell
npm install
npm run dev
```

Open the local URL shown by Vite.

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

The browser test launches the locally installed Microsoft Edge and checks
conversion, GLB export and reload, viewer interaction, responsive layouts,
accessibility, WebGL fallback behavior, and generated geometry normals. Set
`EDGE_PATH` if Edge is installed outside its standard Windows locations.
