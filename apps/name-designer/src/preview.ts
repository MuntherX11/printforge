import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { BuiltPart } from './design'

export class Preview {
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer
  private controls: OrbitControls
  private group: THREE.Group | null = null
  private fitted = false

  constructor(private el: HTMLElement) {
    this.scene.background = new THREE.Color(0x15171c)

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000)
    this.camera.position.set(90, 140, 320)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.target.set(0, 55, 0)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2c33, 1.1)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(120, 220, 180)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5)
    fill.position.set(-160, 80, -120)
    this.scene.add(fill)

    const grid = new THREE.GridHelper(500, 50, 0x3a3d46, 0x24262c)
    this.scene.add(grid)

    const table = new THREE.Mesh(
      new THREE.CircleGeometry(250, 48).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x1b1d23, roughness: 0.95 }),
    )
    table.position.y = -0.2
    this.scene.add(table)

    const resize = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (!w || !h) return
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(w, h)
    }
    new ResizeObserver(resize).observe(el)
    resize()

    const loop = () => {
      requestAnimationFrame(loop)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }

  setParts(parts: BuiltPart[]): void {
    if (this.group) {
      this.scene.remove(this.group)
      this.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
    }
    const group = new THREE.Group()
    const bbox = new THREE.Box3()
    for (const part of parts) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(part.mesh.vertProperties, 3))
      geo.setIndex(new THREE.BufferAttribute(part.mesh.triVerts, 1))
      geo.computeVertexNormals()
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(part.color),
        roughness: 0.55,
        metalness: 0.02,
        flatShading: true,
      })
      const mesh = new THREE.Mesh(geo, mat)
      group.add(mesh)
      geo.computeBoundingBox()
      if (geo.boundingBox) bbox.union(geo.boundingBox)
    }
    this.group = group
    this.scene.add(group)

    if (!this.fitted && parts.length) {
      const size = new THREE.Vector3()
      bbox.getSize(size)
      const center = new THREE.Vector3()
      bbox.getCenter(center)
      const dist = Math.max(size.x, size.y * 1.4) * 1.5 + 80
      this.controls.target.set(center.x, center.y, 0)
      this.camera.position.set(center.x + dist * 0.25, center.y + dist * 0.45, dist)
      this.fitted = true
    }
  }
}
