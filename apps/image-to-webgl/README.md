# Local PNG-to-3D WebGL prototype

This proof of concept converts transparent PNG artwork into a shallow 3D mesh, exports
it as a self-contained GLB, and reloads the GLB into an interactive Three.js viewer.
Conversion and rendering happen locally in the browser.

## What it proves

- A transparent image silhouette can become real, rotatable geometry without a hosted
  AI service.
- Transparent holes are retained as mesh holes.
- The original artwork can be preserved on the front and rear faces while a generated
  material covers the extruded sides.
- Creased vertex normals smooth small traced edge segments while retaining intentional
  sharp corners in the artwork.
- The generated asset can be exported in GLB, the preferred compact format for a
  Three.js/WebGL game.

This is controlled 2.5D extrusion, not full single-view 3D reconstruction. A source
photo does not contain enough information to recover accurate hidden surfaces.

## Run locally

```powershell
npm install
npm run dev
```

From the repository root, run `npm run dev` and open the URL shown by Vite. The
included original prism-ring sample converts automatically. Select another PNG,
or drag one onto the source drop zone, then adjust the extrusion depth and edge controls. The model updates automatically
when a slider is released without resetting the current camera angle or zoom. Use **Download GLB** to save the result. Edge surfaces use the source artwork as a
projected texture, so gradients follow the face colors around the silhouette. The
**Edge color blend** control softens transitions between colors on those surfaces
without blurring the original face artwork. **Edge curve** controls the number of
bevel subdivisions, from a more angular transition to a smoothly rounded edge.
The face and bevel share one continuous projected material to avoid a visible seam
where those surfaces meet.

Use the viewer's **Light environment** / **Dark environment** toggle to inspect the
object against contrasting backgrounds and illumination without regenerating it.
The success status reports contour count, triangle count, and the generated GLB's
download size.

## Validate

```powershell
npm run typecheck
npm test
npm run build
```

The browser smoke test requires the Vite development server to be running in another
terminal:

```powershell
npm run test:browser
```

It launches the locally installed Microsoft Edge, waits for the bundled sample to
convert, checks the GLB preview and download controls, and verifies the WebGL canvas.
Set `EDGE_PATH` if Edge is installed somewhere other than its standard Windows paths.

## Supported input

The prototype deliberately uses a narrow, reliable input contract:

- PNG format
- A transparent background that clearly defines the outer silhouette
- Simple artwork or objects suitable for shallow extrusion

Invalid files, fully transparent images, and images without a transparent background
produce an explicit error. Validation checks the PNG file signature, a 20 MB file-size
limit, decoded dimensions of at most 8192 pixels per side and 25 megapixels, visible
content, and transparency reaching the outside boundary. JPEG and complex-background
segmentation are not included in this phase.

## Local tooling assessment

The current implementation needs only Node.js, npm, Microsoft Edge, and the declared
project dependencies. The installed Three.js development skill supplies relevant
scene, material, glTF, and performance guidance.

Blender is optional for this workflow. Install it when manual mesh inspection, UV
editing, decimation, or artist-driven cleanup becomes useful. It is not required to
run this converter.

Possible later additions:

- Background removal for JPEG and ordinary photographs
- KTX2 textures and mesh compression for production game delivery
- glTF validation and optimization in the asset pipeline
- Local AI reconstruction for assets that require inferred geometry on hidden sides
- Blender-based manual review and cleanup
