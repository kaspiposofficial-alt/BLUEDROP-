/**
 * Bounded Interactive 3D Headphone Studio Character ("DROPY" — Headphones & Wall-Bounce Cage) (`src/media/mascot-stage.ts`)
 *
 * - Chunky stylized audio character wearing oversized studio monitor headphones ("الكاسك")
 * - Follows pointer velocity inside #bd-mascot-stage; on exit (`pointerleave`) or fast swipe,
 *   keeps momentum inside the rectangular studio cage, literally collides with the 4 boundary walls,
 *   squashes slightly, bursts crisp Blocks-palette pixels at the wall impact coordinate, and ricochets back inside.
 * - Software WebGL guard (`isSoftwareGl` + `afterDraw(tick)`), RoomEnvironment PBR, proper cleanup.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const WAKE_PALETTE = ['#F4F03A', '#6E8BFF', '#FFA8E4', '#B9F0C6'] as const;

interface WakeTile {
  col: number;
  row: number;
  color: string;
  alpha: number;
}

const _targetVec = new THREE.Vector3();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export class MascotStageController {
  private readonly host: HTMLElement;
  private wakeCanvas: HTMLCanvasElement;
  private wakeCtx: CanvasRenderingContext2D | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private mascotGroup: THREE.Group | null = null;
  private headGroup: THREE.Group | null = null;
  private leftArm: THREE.Mesh | null = null;
  private rightArm: THREE.Mesh | null = null;
  private eyeLeft: THREE.Mesh | null = null;
  private eyeRight: THREE.Mesh | null = null;
  private mouthBars: THREE.Mesh[] = [];
  private leftSpeakerCore: THREE.Mesh | null = null;
  private rightSpeakerCore: THREE.Mesh | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private rimLight: THREE.DirectionalLight | null = null;
  private wakePalette: string[] = [...WAKE_PALETTE];
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;
  private disposables: Array<{ dispose: () => void }> = [];

  private isSoftwareGl = false;
  private isAudioReactive = false;
  private audioBands: [number, number, number, number] = [0.18, 0.18, 0.18, 0.18];
  private pointerActive = false;
  private pointerTargetX = 0;
  private pointerTargetY = 0;
  private prevPointerX = 0;
  private prevPointerY = 0;
  private lastPointerMs = 0;

  private mascotX = 0;
  private mascotY = 0;
  private velX = 0;
  private velY = 0;
  private squashX = 1;
  private squashY = 1;
  private bounceCount = 0;

  private maxBoundX = 3.1;
  private maxBoundY = 0.72;
  private readonly baseScale = 1.2;
  private readonly camZ = 5.1;

  private lastClockMs = 0;
  private frameId = 0;
  private destroyed = false;
  private wakeTiles = new Map<string, WakeTile>();
  private wakeCursor = 0;
  private lastWakeCell = '';
  private resizeObs: ResizeObserver | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.wakeCanvas = document.createElement('canvas');
    this.wakeCanvas.className = 'bd-mascot-wake';
    this.wakeCanvas.setAttribute('aria-hidden', 'true');
    this.wakeCtx = this.wakeCanvas.getContext('2d');
    this.host.appendChild(this.wakeCanvas);

    this.initScene();
    this.bindEvents();
  }

  public setAudioActive(active: boolean): void {
    this.isAudioReactive = active;
    if (!active) {
      this.audioBands = [0.18, 0.18, 0.18, 0.18];
    }
  }

  public setAudioLevels(bands: [number, number, number, number]): void {
    this.audioBands = bands;
  }

  public applyCollectiveVisualStudy(study: { paletteHexes: string[]; depthRatio: number }): void {
    if (Array.isArray(study.paletteHexes) && study.paletteHexes.length > 0) {
      const validHexes = study.paletteHexes.filter((h) => /^#[0-9A-F]{6}$/i.test(h));
      if (validHexes.length > 0) {
        this.wakePalette = [
          validHexes[0]!,
          '#F4F03A',
          validHexes[1] || '#6E8BFF',
          validHexes[2] || '#FFA8E4',
        ];
        if (this.rimLight) {
          this.rimLight.color.set(validHexes[0]!);
        }
      }
    }
    const clampedDepth = Math.max(10, Math.min(100, Number(study.depthRatio) || 64));
    if (this.rimLight) {
      this.rimLight.intensity = 1.1 + (clampedDepth / 100) * 1.1;
    }
    if (this.hemiLight) {
      this.hemiLight.intensity = 0.68 + (clampedDepth / 100) * 0.42;
    }
    this.host.dataset.visualDepth = String(Math.round(clampedDepth));
  }

  private initScene(): void {
    const width = Math.max(280, this.host.clientWidth || 900);
    const height = Math.max(180, this.host.clientHeight || 265);
    this.isSoftwareGl = detectSoftwareWebGL();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !this.isSoftwareGl,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      this.renderFallbackBadge();
      return;
    }

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.domElement.className = 'bd-mascot-webgl';
    this.host.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTex.texture;
    this.envRenderTarget = envTex;
    pmrem.dispose();

    const aspect = width / height;
    const camera = new THREE.PerspectiveCamera(34, aspect, 0.1, 40);
    camera.position.set(0, 0.15, this.camZ);
    camera.lookAt(0, 0, 0);
    this.camera = camera;
    this.updateStageBounds(aspect);

    const keyLight = new THREE.DirectionalLight(0xfff4dc, 1.9);
    keyLight.position.set(4, 6, 5);
    scene.add(keyLight);

    const hemiLight = new THREE.HemisphereLight(0xaec6ff, 0x1a1a18, 0.85);
    scene.add(hemiLight);
    this.hemiLight = hemiLight;

    const rimLight = new THREE.DirectionalLight(0x6e8bff, 1.45);
    rimLight.position.set(-4, 2, -4);
    scene.add(rimLight);
    this.rimLight = rimLight;

    this.buildMascotGroup(scene);

    renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.stopLoop();
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.startLoop();
    });

    this.resizeWakeCanvas(width, height);
    this.lastClockMs = performance.now();
    this.startLoop();
  }

  private buildMascotGroup(scene: THREE.Scene): void {
    const root = new THREE.Group();
    const head = new THREE.Group();

    const matObsidian = new THREE.MeshStandardMaterial({
      color: 0x1c1c1b,
      roughness: 0.44,
      metalness: 0.25,
    });
    const matBone = new THREE.MeshStandardMaterial({
      color: 0xf3f0e6,
      roughness: 0.5,
      metalness: 0.08,
    });
    const matVisor = new THREE.MeshStandardMaterial({
      color: 0x0b0b0b,
      roughness: 0.12,
      metalness: 0.72,
    });
    const matSolar = new THREE.MeshStandardMaterial({
      color: 0xf4f03a,
      emissive: 0xf4f03a,
      emissiveIntensity: 0.65,
      roughness: 0.28,
      metalness: 0.1,
    });
    const matBlue = new THREE.MeshStandardMaterial({
      color: 0x6e8bff,
      roughness: 0.25,
      metalness: 0.55,
    });
    const matRose = new THREE.MeshStandardMaterial({
      color: 0xffa8e4,
      roughness: 0.68,
      metalness: 0.06,
    });
    const matMint = new THREE.MeshStandardMaterial({
      color: 0xb9f0c6,
      roughness: 0.35,
      metalness: 0.22,
    });
    this.disposables.push(matObsidian, matBone, matVisor, matSolar, matBlue, matRose, matMint);

    // 1. Torso hoodie & base stepped shoes (Blocks layered geometry)
    const torsoGeo = new THREE.BoxGeometry(0.68, 0.44, 0.48);
    const collarGeo = new THREE.BoxGeometry(0.76, 0.11, 0.52);
    const shoeGeo = new THREE.BoxGeometry(0.24, 0.12, 0.34);
    this.disposables.push(torsoGeo, collarGeo, shoeGeo);

    const torso = new THREE.Mesh(torsoGeo, matObsidian);
    torso.position.set(0, -0.34, 0);
    const collar = new THREE.Mesh(collarGeo, matBlue);
    collar.position.set(0, -0.11, 0);
    const shoeL = new THREE.Mesh(shoeGeo, matBone);
    shoeL.position.set(-0.2, -0.62, 0.05);
    const shoeR = new THREE.Mesh(shoeGeo, matBone);
    shoeR.position.set(0.2, -0.62, 0.05);
    root.add(torso, collar, shoeL, shoeR);

    // 2. Expressive Arms (Mint & Bone)
    const armGeo = new THREE.BoxGeometry(0.16, 0.32, 0.18);
    this.disposables.push(armGeo);
    const lArm = new THREE.Mesh(armGeo, matMint);
    lArm.position.set(-0.46, -0.3, 0.06);
    const rArm = new THREE.Mesh(armGeo, matMint);
    rArm.position.set(0.46, -0.3, 0.06);
    root.add(lArm, rArm);
    this.leftArm = lArm;
    this.rightArm = rArm;

    // 3. Head Block + Stepped Top Cap + Glossy Visor
    const headGeo = new THREE.BoxGeometry(0.78, 0.62, 0.64);
    const visorGeo = new THREE.BoxGeometry(0.66, 0.38, 0.08);
    const capStepGeo = new THREE.BoxGeometry(0.56, 0.08, 0.48);
    this.disposables.push(headGeo, visorGeo, capStepGeo);

    const headBox = new THREE.Mesh(headGeo, matBone);
    headBox.position.set(0, 0.24, 0);
    const capStep = new THREE.Mesh(capStepGeo, matObsidian);
    capStep.position.set(0, 0.57, 0);
    const visor = new THREE.Mesh(visorGeo, matVisor);
    visor.position.set(0, 0.23, 0.32);
    head.add(headBox, capStep, visor);

    // 4. Solar Pixel Eyes + 3 Equalizer Mouth Bars
    const eyeGeo = new THREE.BoxGeometry(0.12, 0.12, 0.05);
    const mouthGeo = new THREE.BoxGeometry(0.065, 0.09, 0.04);
    this.disposables.push(eyeGeo, mouthGeo);

    const eyeL = new THREE.Mesh(eyeGeo, matSolar);
    const eyeR = new THREE.Mesh(eyeGeo, matSolar);
    eyeL.position.set(-0.16, 0.28, 0.36);
    eyeR.position.set(0.16, 0.28, 0.36);
    head.add(eyeL, eyeR);
    this.eyeLeft = eyeL;
    this.eyeRight = eyeR;

    this.mouthBars = [];
    for (let i = -1; i <= 1; i += 1) {
      const bar = new THREE.Mesh(mouthGeo, matMint);
      bar.position.set(i * 0.09, 0.13, 0.36);
      head.add(bar);
      this.mouthBars.push(bar);
    }

    // 5. Chunky Studio Monitor Headphones ("الكاسك")
    const bandGeo = new THREE.TorusGeometry(0.5, 0.065, 14, 32, Math.PI);
    const yokeGeo = new THREE.BoxGeometry(0.07, 0.2, 0.09);
    const cupGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.15, 22);
    const ringGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.17, 20);
    const coreGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.19, 16);
    this.disposables.push(bandGeo, yokeGeo, cupGeo, ringGeo, coreGeo);

    const band = new THREE.Mesh(bandGeo, matBlue);
    band.position.set(0, 0.34, 0);
    head.add(band);

    const yokeL = new THREE.Mesh(yokeGeo, matObsidian);
    yokeL.position.set(-0.48, 0.3, 0);
    const yokeR = new THREE.Mesh(yokeGeo, matObsidian);
    yokeR.position.set(0.48, 0.3, 0);
    head.add(yokeL, yokeR);

    const cupL = new THREE.Mesh(cupGeo, matRose);
    cupL.rotation.z = Math.PI / 2;
    cupL.position.set(-0.49, 0.22, 0);
    const cupR = new THREE.Mesh(cupGeo, matRose);
    cupR.rotation.z = Math.PI / 2;
    cupR.position.set(0.49, 0.22, 0);

    const ringL = new THREE.Mesh(ringGeo, matObsidian);
    ringL.rotation.z = Math.PI / 2;
    ringL.position.set(-0.5, 0.22, 0);
    const ringR = new THREE.Mesh(ringGeo, matObsidian);
    ringR.rotation.z = Math.PI / 2;
    ringR.position.set(0.5, 0.22, 0);

    const coreL = new THREE.Mesh(coreGeo, matSolar);
    coreL.rotation.z = Math.PI / 2;
    coreL.position.set(-0.51, 0.22, 0);
    const coreR = new THREE.Mesh(coreGeo, matSolar);
    coreR.rotation.z = Math.PI / 2;
    coreR.position.set(0.51, 0.22, 0);
    this.leftSpeakerCore = coreL;
    this.rightSpeakerCore = coreR;

    head.add(cupL, cupR, ringL, ringR, coreL, coreR);

    root.add(head);
    root.scale.setScalar(this.baseScale);
    scene.add(root);

    this.mascotGroup = root;
    this.headGroup = head;
  }

  private renderFallbackBadge(): void {
    const fallback = document.createElement('div');
    fallback.className = 'bd-mono-label';
    fallback.style.cssText =
      'position:relative;z-index:2;color:#F4F03A;padding:18px;text-align:center;';
    fallback.textContent = 'BLUEDROP HEADPHONE BOT · BOUNDED WALL-BOUNCE CAGE';
    this.host.appendChild(fallback);
  }

  private updateStageBounds(aspect: number): void {
    const visibleHalfH = Math.tan(THREE.MathUtils.degToRad(34 / 2)) * this.camZ;
    const visibleHalfW = visibleHalfH * aspect;
    this.maxBoundX = Math.max(0.7, visibleHalfW - 0.85);
    this.maxBoundY = Math.max(0.28, visibleHalfH - 0.72);
  }

  private bindEvents(): void {
    this.host.addEventListener('pointerenter', this.onPointerMove, { passive: true });
    this.host.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.host.addEventListener('pointerdown', this.onPointerMove, { passive: true });
    this.host.addEventListener('pointerleave', this.onPointerLeave, { passive: true });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.onResize());
      this.resizeObs.observe(this.host);
    }
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const clampedX = THREE.MathUtils.clamp(nx * this.maxBoundX * 1.05, -this.maxBoundX, this.maxBoundX);
    const clampedY = THREE.MathUtils.clamp(ny * this.maxBoundY * 1.05, -this.maxBoundY, this.maxBoundY);

    const now = performance.now();
    if (this.pointerActive && this.lastPointerMs > 0) {
      const dt = Math.max(0.008, (now - this.lastPointerMs) / 1000);
      this.prevPointerX = (clampedX - this.pointerTargetX) / dt;
      this.prevPointerY = (clampedY - this.pointerTargetY) / dt;
    }
    this.lastPointerMs = now;
    this.pointerActive = true;
    this.pointerTargetX = clampedX;
    this.pointerTargetY = clampedY;
  };

  private readonly onPointerLeave = (): void => {
    this.pointerActive = false;
    // Launch along exit trajectory toward the cage boundary so leaving the studio box bounces the character off the wall
    const exitVx = Math.abs(this.prevPointerX) > 0.4 ? this.prevPointerX * 0.45 : (this.mascotX >= 0 ? 2.4 : -2.4);
    const exitVy = Math.abs(this.prevPointerY) > 0.25 ? this.prevPointerY * 0.45 : (this.mascotY >= 0 ? 1.15 : -1.15);
    this.velX = THREE.MathUtils.clamp(exitVx, -4.8, 4.8);
    this.velY = THREE.MathUtils.clamp(exitVy, -2.6, 2.6);
    if (Math.hypot(this.velX, this.velY) < 1.8) {
      this.velX = this.velX >= 0 ? 2.4 : -2.4;
      this.velY = this.velY >= 0 ? 1.05 : -1.05;
    }
  };

  private onResize(): void {
    const w = Math.max(280, this.host.clientWidth || 900);
    const h = Math.max(180, this.host.clientHeight || 265);
    if (this.camera && this.renderer) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.updateStageBounds(w / h);
    }
    this.resizeWakeCanvas(w, h);
  }

  private resizeWakeCanvas(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.wakeCanvas.width = w * dpr;
    this.wakeCanvas.height = h * dpr;
    this.wakeCanvas.style.width = `${w}px`;
    this.wakeCanvas.style.height = `${h}px`;
    if (this.wakeCtx) {
      this.wakeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private triggerWallImpact(impactX: number, impactY: number, axis: 'x' | 'y'): void {
    this.bounceCount += 1;
    if (axis === 'x') {
      this.squashX = 0.78;
      this.squashY = 1.2;
    } else {
      this.squashX = 1.18;
      this.squashY = 0.8;
    }

    if (!this.camera) return;
    const w = this.host.clientWidth || 900;
    const h = this.host.clientHeight || 265;
    const cell = 20;
    _targetVec.set(impactX, impactY, 0).project(this.camera);
    const sx = THREE.MathUtils.clamp((( _targetVec.x + 1) / 2) * w, 12, w - 12);
    const sy = THREE.MathUtils.clamp(((-_targetVec.y + 1) / 2) * h, 12, h - 12);
    const col = Math.floor(sx / cell);
    const row = Math.floor(sy / cell);

    const offsets: Array<[number, number, number]> = [
      [0, 0, 1.0],
      [-1, 0, 0.85],
      [1, 0, 0.85],
      [0, -1, 0.8],
      [0, 1, 0.8],
    ];
    for (const [dc, dr, a] of offsets) {
      const c = col + dc;
      const r = row + dr;
      const color =
        this.wakePalette[(this.wakeCursor + Math.abs(dc + dr)) % this.wakePalette.length] ||
        '#F4F03A';
      this.wakeCursor += 1;
      this.wakeTiles.set(`${c}:${r}`, { col: c, row: r, color, alpha: a });
    }
  }

  private spawnWakeFromMascot(dt: number): void {
    const ctx = this.wakeCtx;
    if (!ctx || !this.camera) return;
    const w = this.host.clientWidth || 900;
    const h = this.host.clientHeight || 265;
    const cell = 20;

    _targetVec.set(this.mascotX, this.mascotY, 0).project(this.camera);
    const sx = ((_targetVec.x + 1) / 2) * w;
    const sy = ((-_targetVec.y + 1) / 2) * h;

    const col = Math.floor(sx / cell);
    const row = Math.floor(sy / cell);
    const key = `${col}:${row}`;
    if (key !== this.lastWakeCell) {
      this.lastWakeCell = key;
      for (const [dc, dr, a] of [
        [0, 0, 0.92],
        [-1, 0, 0.6],
        [0, 1, 0.55],
      ] as const) {
        const c = col + dc;
        const r = row + dr;
        const k = `${c}:${r}`;
        const color = this.wakePalette[this.wakeCursor % this.wakePalette.length] || '#F4F03A';
        this.wakeCursor += 1;
        this.wakeTiles.set(k, { col: c, row: r, color, alpha: a });
      }
    }

    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x += cell) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += cell) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(w, y + 0.5);
    }
    ctx.stroke();

    for (const [k, tile] of this.wakeTiles.entries()) {
      tile.alpha -= dt * 1.15;
      if (tile.alpha <= 0.02) {
        this.wakeTiles.delete(k);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = tile.alpha * 0.8;
      ctx.fillStyle = tile.color;
      ctx.fillRect(tile.col * cell + 1, tile.row * cell + 1, cell - 2, cell - 2);
      ctx.restore();
    }
  }

  private startLoop(): void {
    this.stopLoop();
    const tick = () => {
      if (this.destroyed || !this.renderer || !this.scene || !this.camera) return;
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastClockMs) / 1000));
      this.lastClockMs = now;
      const t = now * 0.001;

      if (this.pointerActive) {
        const prevX = this.mascotX;
        const prevY = this.mascotY;
        this.mascotX = THREE.MathUtils.damp(this.mascotX, this.pointerTargetX, 8.2, dt);
        this.mascotY = THREE.MathUtils.damp(this.mascotY, this.pointerTargetY, 8.2, dt);
        this.velX = THREE.MathUtils.lerp(this.velX, (this.mascotX - prevX) / dt, 0.35);
        this.velY = THREE.MathUtils.lerp(this.velY, (this.mascotY - prevY) / dt, 0.35);
      } else {
        // Free-flight ricochet physics inside bounded studio cage
        this.mascotX += this.velX * dt;
        this.mascotY += this.velY * dt;
        // Mild damping so it keeps patrolling nicely
        this.velX *= Math.pow(0.96, dt * 60);
        this.velY *= Math.pow(0.96, dt * 60);
        if (Math.hypot(this.velX, this.velY) < 0.08) {
          this.velX = 0;
          this.velY = 0;
        }
      }

      // Strict Wall-Collision Clamping & Ricochet
      if (this.mascotX >= this.maxBoundX) {
        this.mascotX = this.maxBoundX;
        if (this.velX > 0.15) {
          this.velX = -Math.max(0.95, Math.abs(this.velX) * 0.92);
          this.triggerWallImpact(this.maxBoundX, this.mascotY, 'x');
        }
      } else if (this.mascotX <= -this.maxBoundX) {
        this.mascotX = -this.maxBoundX;
        if (this.velX < -0.15) {
          this.velX = Math.max(0.95, Math.abs(this.velX) * 0.92);
          this.triggerWallImpact(-this.maxBoundX, this.mascotY, 'x');
        }
      }

      if (this.mascotY >= this.maxBoundY) {
        this.mascotY = this.maxBoundY;
        if (this.velY > 0.12) {
          this.velY = -Math.max(0.75, Math.abs(this.velY) * 0.92);
          this.triggerWallImpact(this.mascotX, this.maxBoundY, 'y');
        }
      } else if (this.mascotY <= -this.maxBoundY) {
        this.mascotY = -this.maxBoundY;
        if (this.velY < -0.12) {
          this.velY = Math.max(0.75, Math.abs(this.velY) * 0.92);
          this.triggerWallImpact(this.mascotX, -this.maxBoundY, 'y');
        }
      }

      this.squashX = THREE.MathUtils.damp(this.squashX, 1, 10, dt);
      this.squashY = THREE.MathUtils.damp(this.squashY, 1, 10, dt);

      const [bass, mid1, mid2, high] = this.audioBands;
      const energy = Math.max(0, (bass + mid1 + mid2 + high) / 4 - 0.18);

      if (this.mascotGroup) {
        const hoverY = this.isAudioReactive ? Math.sin(t * 4.8) * (0.02 + energy * 0.09) : 0;
        this.mascotGroup.position.x = this.mascotX;
        this.mascotGroup.position.y = THREE.MathUtils.clamp(
          this.mascotY + hoverY,
          -this.maxBoundY,
          this.maxBoundY
        );
        this.mascotGroup.scale.set(
          this.baseScale * this.squashX,
          this.baseScale * this.squashY,
          this.baseScale
        );
        this.mascotGroup.rotation.z = THREE.MathUtils.clamp(-this.velX * 0.075, -0.38, 0.38);
        const lookDx = this.pointerActive ? this.pointerTargetX - this.mascotX : this.velX * 0.35;
        this.mascotGroup.rotation.y = THREE.MathUtils.clamp(lookDx * 0.42, -0.55, 0.55);
      }

      if (this.headGroup) {
        const targetBob = this.isAudioReactive ? Math.max(0, bass - 0.18) * 0.22 : 0;
        this.headGroup.rotation.x = THREE.MathUtils.damp(this.headGroup.rotation.x, targetBob, 14, dt);
      }

      if (this.leftArm && this.rightArm) {
        const swing = this.isAudioReactive ? Math.sin(t * 8.5) * (0.1 + energy * 0.32) : 0;
        this.leftArm.rotation.z = THREE.MathUtils.damp(this.leftArm.rotation.z, 0.18 + swing, 12, dt);
        this.rightArm.rotation.z = THREE.MathUtils.damp(this.rightArm.rotation.z, -0.18 - swing, 12, dt);
      }

      if (this.leftSpeakerCore && this.rightSpeakerCore) {
        const targetPulse = this.isAudioReactive ? 1 + Math.max(0, bass - 0.18) * 0.42 : 1;
        const curPulse = THREE.MathUtils.damp(this.leftSpeakerCore.scale.x, targetPulse, 18, dt);
        this.leftSpeakerCore.scale.set(curPulse, 1, curPulse);
        this.rightSpeakerCore.scale.set(curPulse, 1, curPulse);
      }

      const barTargets = [bass, (mid1 + mid2) * 0.5, high];
      for (let i = 0; i < this.mouthBars.length; i += 1) {
        const bar = this.mouthBars[i]!;
        const bandLevel = Math.max(0, (barTargets[i] ?? 0.18) - 0.18);
        const targetWave = this.isAudioReactive ? 0.32 + bandLevel * 1.9 : 0.28;
        bar.scale.y = THREE.MathUtils.damp(bar.scale.y, targetWave, 20, dt);
      }

      if (this.eyeLeft && this.eyeRight) {
        const blink = Math.sin(t * 1.4) > 0.985 ? 0.16 : 1;
        this.eyeLeft.scale.y = blink;
        this.eyeRight.scale.y = blink;
      }

      this.host.dataset.mascotX = this.mascotX.toFixed(2);
      this.host.dataset.mascotY = this.mascotY.toFixed(2);
      this.host.dataset.mascotBounces = String(this.bounceCount);

      this.spawnWakeFromMascot(dt);
      this.renderer.render(this.scene, this.camera);

      if (this.isSoftwareGl) {
        this.afterDraw(tick);
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private afterDraw(cb: () => void): void {
    if (!this.renderer) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (this.destroyed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          this.frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameId = window.setTimeout(cb, 80);
        }
      };
      this.frameId = window.setTimeout(poll, 5);
    } else {
      this.frameId = window.setTimeout(cb, 80);
    }
  }

  private stopLoop(): void {
    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      clearTimeout(this.frameId);
      this.frameId = 0;
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    this.resizeObs?.disconnect();
    this.host.removeEventListener('pointerenter', this.onPointerMove);
    this.host.removeEventListener('pointermove', this.onPointerMove);
    this.host.removeEventListener('pointerdown', this.onPointerMove);
    this.host.removeEventListener('pointerleave', this.onPointerLeave);
    for (const d of this.disposables) d.dispose();
    this.envRenderTarget?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.wakeCanvas.remove();
  }
}
