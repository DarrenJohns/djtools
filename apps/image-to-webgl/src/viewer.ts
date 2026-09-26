import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  Material,
  Mesh,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export class ModelViewer {
  private readonly container: HTMLElement
  private readonly controlPanel: HTMLElement | null
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(42, 1, 0.01, 100)
  private renderer: WebGLRenderer | null = null
  private controls: OrbitControls | null = null
  private resizeObserver: ResizeObserver | null = null
  private readonly ambient = new AmbientLight()
  private readonly key = new DirectionalLight()
  private readonly rim = new DirectionalLight()
  private readonly projectionProbe = new Vector3()
  private grid: GridHelper | null = null
  private model: Group | null = null
  private fallback: HTMLElement | null = null
  private modelExtent = 1
  private animationFrame = 0
  private disposed = false
  private readonly reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly desktopFramingQuery = window.matchMedia('(min-width: 801px)')

  constructor(container: HTMLElement) {
    this.container = container
    this.controlPanel = container.closest('.layout')?.querySelector<HTMLElement>('.control-panel') ?? null
    this.scene.background = new Color(0x101827)
    this.camera.position.set(2.3, 1.5, 2.8)

    this.scene.add(this.ambient)

    this.key.position.set(3, 4, 5)
    this.key.castShadow = true
    this.scene.add(this.key)

    this.rim.position.set(-4, 2, -3)
    this.scene.add(this.rim)

    if (!this.initializeRenderer()) return

    this.setEnvironment('dark')

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    if (this.controlPanel) this.resizeObserver.observe(this.controlPanel)
    this.desktopFramingQuery.addEventListener('change', this.resize)
    this.resize()
    this.animate()
  }

  async loadGlb(
    glb: ArrayBuffer,
    { preserveView = false }: { preserveView?: boolean } = {},
  ): Promise<void> {
    if (!this.renderer || !this.controls) return

    const loader = new GLTFLoader()
    let loaded: Group
    try {
      const gltf = await loader.parseAsync(glb.slice(0), '')
      loaded = gltf.scene
    } catch (error) {
      throw new Error('The generated GLB could not be loaded for preview.', { cause: error })
    }

    if (!this.renderer || !this.controls) {
      this.disposeModel(loaded)
      return
    }

    if (this.model) {
      this.scene.remove(this.model)
      this.disposeModel(this.model)
    }
    this.model = loaded
    this.scene.add(loaded)

    const bounds = new Box3().setFromObject(loaded)
    if (bounds.isEmpty()) {
      throw new Error('The generated GLB contains no visible geometry.')
    }

    const center = bounds.getCenter(new Vector3())
    const size = bounds.getSize(new Vector3())
    loaded.position.sub(center)
    const extent = Math.max(size.x, size.y, size.z)
    this.modelExtent = extent
    this.camera.near = Math.max(0.001, extent / 100)
    this.camera.far = extent * 100
    this.camera.updateProjectionMatrix()
    if (!preserveView) {
      this.restoreDefaultView()
    }
    this.controls.update()
  }

  private restoreDefaultView(): void {
    if (!this.renderer || !this.controls) return

    const extent = this.modelExtent
    this.controls.target.set(0, 0, 0)
    this.camera.up.set(0, 1, 0)
    this.camera.position.set(extent * 1.4, extent * 0.9, extent * 1.8)
    this.controls.update()
    this.renderer.domElement.dataset.view = 'isometric'
  }

  setEnvironment(mode: 'dark' | 'light'): void {
    if (!this.renderer) return

    this.scene.background = new Color(mode === 'dark' ? 0x101827 : 0xe8eef5)
    this.ambient.color.set(mode === 'dark' ? 0xffffff : 0xdde8f3)
    this.ambient.intensity = mode === 'dark' ? 1.1 : 1.7
    this.key.color.set(0xffffff)
    this.key.intensity = mode === 'dark' ? 3.2 : 2.5
    this.rim.color.set(mode === 'dark' ? 0x66c8ff : 0x6a8eae)
    this.rim.intensity = mode === 'dark' ? 1.6 : 0.8

    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.dispose()
    }
    this.grid = new GridHelper(
      5,
      20,
      mode === 'dark' ? 0x456080 : 0x8298ad,
      mode === 'dark' ? 0x24364f : 0xc4d0dc,
    )
    this.grid.position.y = -0.8
    this.scene.add(this.grid)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    cancelAnimationFrame(this.animationFrame)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.reducedMotionQuery.removeEventListener('change', this.updateMotionPreference)
    this.desktopFramingQuery.removeEventListener('change', this.resize)
    this.controls?.dispose()
    this.controls = null
    if (this.model) {
      this.scene.remove(this.model)
      this.disposeModel(this.model)
      this.model = null
    }
    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.dispose()
      this.grid = null
    }
    if (this.renderer) {
      this.renderer.domElement.removeEventListener('keydown', this.handleKeyDown)
      this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost)
      this.renderer.dispose()
      this.renderer.domElement.remove()
      this.renderer = null
    }
    this.fallback?.remove()
    this.fallback = null
  }

  private resize = (): void => {
    if (!this.renderer) return

    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.camera.aspect = width / height
    this.camera.clearViewOffset()

    if (this.desktopFramingQuery.matches && this.controlPanel) {
      const viewerBounds = this.container.getBoundingClientRect()
      const panelBounds = this.controlPanel.getBoundingClientRect()
      const obscuredWidth = Math.max(
        0,
        Math.min(width, panelBounds.right - viewerBounds.left),
      )

      if (obscuredWidth > 0) {
        this.camera.setViewOffset(width, height, -obscuredWidth / 2, 0, width, height)
      }
    }

    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
  }

  private disposeModel(model: Group): void {
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      const materials: Material[] = Array.isArray(object.material)
        ? object.material
        : [object.material]
      materials.forEach((material) => {
        Object.values(material).forEach((value) => {
          if (value instanceof Texture) value.dispose()
        })
        material.dispose()
      })
    })
  }

  private updateMotionPreference = (): void => {
    if (!this.renderer || !this.controls) return

    this.controls.enableDamping = !this.reducedMotionQuery.matches
    this.renderer.domElement.dataset.motion = this.reducedMotionQuery.matches ? 'reduced' : 'full'
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.renderer || !this.controls) return

    const offset = this.camera.position.clone().sub(this.controls.target)
    const rotationStep = Math.PI / 18

    switch (event.key) {
      case 'ArrowLeft':
        offset.applyAxisAngle(this.camera.up, rotationStep)
        break
      case 'ArrowRight':
        offset.applyAxisAngle(this.camera.up, -rotationStep)
        break
      case 'ArrowUp': {
        const right = new Vector3().crossVectors(offset, this.camera.up).normalize()
        offset.applyAxisAngle(right, -rotationStep)
        break
      }
      case 'ArrowDown': {
        const right = new Vector3().crossVectors(offset, this.camera.up).normalize()
        offset.applyAxisAngle(right, rotationStep)
        break
      }
      case '+':
      case '=':
        offset.multiplyScalar(0.9)
        break
      case '-':
      case '_':
        offset.multiplyScalar(1.1)
        break
      case 'Home':
        this.restoreDefaultView()
        event.preventDefault()
        return
      default:
        return
    }

    this.camera.position.copy(this.controls.target).add(offset)
    this.controls.update()
    this.renderer.domElement.dataset.view = 'custom'
    event.preventDefault()
  }

  private animate = (): void => {
    if (!this.renderer || !this.controls) return

    this.animationFrame = requestAnimationFrame(this.animate)
    this.controls.update()
    const projectedCenter = this.projectionProbe.set(0, 0, 0).project(this.camera)
    const canvas = this.renderer.domElement
    canvas.dataset.projectedCenterX = (
      (projectedCenter.x + 1) * this.container.clientWidth / 2
    ).toFixed(2)
    canvas.dataset.projectedCenterY = (
      (1 - projectedCenter.y) * this.container.clientHeight / 2
    ).toFixed(2)
    const { x, y, z } = this.camera.position
    canvas.dataset.cameraPosition =
      `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`
    this.renderer.render(this.scene, this.camera)
  }

  private initializeRenderer(): boolean {
    let renderer: WebGLRenderer | null = null
    let controls: OrbitControls | null = null

    try {
      renderer = new WebGLRenderer({ antialias: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.shadowMap.enabled = true
      renderer.domElement.tabIndex = 0
      renderer.domElement.setAttribute('role', 'img')
      renderer.domElement.setAttribute(
        'aria-label',
        'Interactive 3D object preview. Use arrow keys to rotate, plus or minus to zoom, and Home to reset the view.',
      )
      renderer.domElement.setAttribute('aria-describedby', 'viewer-hint')
      renderer.domElement.setAttribute(
        'aria-keyshortcuts',
        'ArrowLeft ArrowRight ArrowUp ArrowDown + - Home',
      )
      renderer.domElement.addEventListener('keydown', this.handleKeyDown)
      renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost)

      controls = new OrbitControls(this.camera, renderer.domElement)
      controls.dampingFactor = 0.06

      this.renderer = renderer
      this.controls = controls
      this.updateMotionPreference()
      this.reducedMotionQuery.addEventListener('change', this.updateMotionPreference)
      this.container.appendChild(renderer.domElement)
      return true
    } catch (error) {
      console.error('Unable to initialize the 3D preview renderer.', error)
      try {
        renderer?.domElement.removeEventListener('keydown', this.handleKeyDown)
        renderer?.domElement.removeEventListener('webglcontextlost', this.handleContextLost)
        controls?.dispose()
        renderer?.dispose()
      } catch (cleanupError) {
        console.error('Unable to fully clean up the failed 3D preview renderer.', cleanupError)
      } finally {
        renderer?.domElement.remove()
        this.controls = null
        this.renderer = null
      }
      this.reducedMotionQuery.removeEventListener('change', this.updateMotionPreference)
      this.showFallback('status')
      return false
    }
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault()
    console.error('The WebGL context was lost; the 3D preview has been disabled.')

    cancelAnimationFrame(this.animationFrame)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.reducedMotionQuery.removeEventListener('change', this.updateMotionPreference)
    this.desktopFramingQuery.removeEventListener('change', this.resize)
    this.controls?.dispose()
    this.controls = null

    if (this.model) {
      this.scene.remove(this.model)
      this.disposeModel(this.model)
      this.model = null
    }
    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.dispose()
      this.grid = null
    }
    if (this.renderer) {
      this.renderer.domElement.removeEventListener('keydown', this.handleKeyDown)
      this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost)
      this.renderer.dispose()
      this.renderer.domElement.remove()
      this.renderer = null
    }

    this.showFallback('alert')
  }

  private showFallback(role: 'status' | 'alert'): void {
    if (this.disposed) return

    if (!this.fallback) {
      const fallback = document.createElement('div')
      fallback.className = 'viewer-fallback'

      const title = document.createElement('p')
      title.className = 'viewer-fallback-title'
      title.textContent = '3D preview unavailable'

      const message = document.createElement('p')
      message.className = 'viewer-fallback-message'
      message.textContent =
        'Your image can still be converted, and the 3D model can still be downloaded.'

      fallback.append(title, message)
      this.fallback = fallback
    }

    this.fallback.setAttribute('role', role)
    this.fallback.setAttribute('aria-live', role === 'alert' ? 'assertive' : 'polite')
    this.container.appendChild(this.fallback)
  }
}
