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
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(42, 1, 0.01, 100)
  private readonly renderer: WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly ambient = new AmbientLight()
  private readonly key = new DirectionalLight()
  private readonly rim = new DirectionalLight()
  private grid: GridHelper
  private model: Group | null = null
  private modelExtent = 1
  private animationFrame = 0
  private readonly reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(container: HTMLElement) {
    this.container = container
    this.scene.background = new Color(0x101827)
    this.camera.position.set(2.3, 1.5, 2.8)

    this.renderer = new WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.domElement.tabIndex = 0
    this.renderer.domElement.setAttribute('role', 'img')
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Interactive 3D object preview. Use arrow keys to rotate, plus or minus to zoom, and Home to reset the view.',
    )
    this.renderer.domElement.setAttribute('aria-describedby', 'viewer-hint')
    this.renderer.domElement.setAttribute(
      'aria-keyshortcuts',
      'ArrowLeft ArrowRight ArrowUp ArrowDown + - Home',
    )
    container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.dampingFactor = 0.06
    this.updateMotionPreference()
    this.reducedMotionQuery.addEventListener('change', this.updateMotionPreference)
    this.renderer.domElement.addEventListener('keydown', this.handleKeyDown)

    this.scene.add(this.ambient)

    this.key.position.set(3, 4, 5)
    this.key.castShadow = true
    this.scene.add(this.key)

    this.rim.position.set(-4, 2, -3)
    this.scene.add(this.rim)

    this.grid = new GridHelper()
    this.setEnvironment('dark')

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.animate()
  }

  async loadGlb(
    glb: ArrayBuffer,
    { preserveView = false }: { preserveView?: boolean } = {},
  ): Promise<void> {
    const loader = new GLTFLoader()
    let loaded: Group
    try {
      const gltf = await loader.parseAsync(glb.slice(0), '')
      loaded = gltf.scene
    } catch (error) {
      throw new Error('The generated GLB could not be loaded for preview.', { cause: error })
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
    const extent = this.modelExtent
    this.controls.target.set(0, 0, 0)
    this.camera.up.set(0, 1, 0)
    this.camera.position.set(extent * 1.4, extent * 0.9, extent * 1.8)
    this.controls.update()
    this.renderer.domElement.dataset.view = 'isometric'
  }

  setEnvironment(mode: 'dark' | 'light'): void {
    this.scene.background = new Color(mode === 'dark' ? 0x101827 : 0xe8eef5)
    this.ambient.color.set(mode === 'dark' ? 0xffffff : 0xdde8f3)
    this.ambient.intensity = mode === 'dark' ? 1.1 : 1.7
    this.key.color.set(0xffffff)
    this.key.intensity = mode === 'dark' ? 3.2 : 2.5
    this.rim.color.set(mode === 'dark' ? 0x66c8ff : 0x6a8eae)
    this.rim.intensity = mode === 'dark' ? 1.6 : 0.8

    this.scene.remove(this.grid)
    this.grid.dispose()
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
    cancelAnimationFrame(this.animationFrame)
    this.resizeObserver.disconnect()
    this.reducedMotionQuery.removeEventListener('change', this.updateMotionPreference)
    this.renderer.domElement.removeEventListener('keydown', this.handleKeyDown)
    this.controls.dispose()
    if (this.model) {
      this.disposeModel(this.model)
      this.model = null
    }
    this.grid.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.camera.aspect = width / height
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
    this.controls.enableDamping = !this.reducedMotionQuery.matches
    this.renderer.domElement.dataset.motion = this.reducedMotionQuery.matches ? 'reduced' : 'full'
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
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
    this.animationFrame = requestAnimationFrame(this.animate)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }
}
