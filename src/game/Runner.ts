import DistanceMeter from "./DistanceMeter"
import GameOverPanel from "./GameOverPanel"
import PressToStart from "./PressToStart"
import HPBar from "./HPBar"
import Horizon from "./Horizon"
import Trex from "./Trex"
import { checkForCollision } from "./collisionDetection"
import { FPS, IS_HIDPI, IS_IOS, IS_MOBILE } from "./varibles"
import { Agent } from "@/rl/agent"

const DEFAULT_WIDTH = 600
const RESOURCE_POSTFIX = "offline-resources-"
const BDAY_SPRITE_POSTFIX = "offline-bday-sprite-"

export default class Runner extends Agent {
  canvas!: HTMLCanvasElement // Canvas object
  ctx!: CanvasRenderingContext2D // Canvas context
  spriteDef!: SpritePosDef // Sprite definition

  outerContainerEl!: HTMLElement
  containerEl!: HTMLElement

  config: ConfigDict = Runner.config // Default configuration
  dimensions = Runner.defaultDimensions // Canvas dimensions used for positioning and scaling

  time = Date.now()
  runningTime = 0
  currentSpeed = Runner.config.SPEED

  activated = false
  playing = false
  crashed = false
  paused = false
  inverted = false // Night mode on
  inverTimer = 0 // Night mode start time
  invertTrigger = false
  updatePending = false
  resizeTimerId_: NodeJS.Timer | null = null // window resizing delay

  raqId = 0 // requestAnimationFrame

  tRex!: Trex // Paint objects
  horizon!: Horizon
  distanceMeter!: DistanceMeter
  gameOverPanel!: GameOverPanel
  pressToStart!: PressToStart
  hpBar!: HPBar

  playingIntro!: boolean // Playing intro when first start

  msPerFrame = 1000 / FPS // ms per frame
  distanceRan = 0
  highestScore = 0

  audioContext!: AudioContext // Collision sound
  soundFx: ConfigDict = {} // Sound FX map

  hp = HPBar.config.MAX_HP // HP value

  constructor(outerContainerId: string, optConfig?: ConfigDict) {
    super()
    this.outerContainerEl = document.querySelector(outerContainerId)!
    this.config = optConfig || Object.assign(Runner.config, Runner.normalConfig)

    this.loadImages()
  }

  /**
  * Prepare data and dump out for machine learning.
  */
  _store_observation() {
    this.metadata.score = Math.floor(this.distanceRan);
    try {
      this.metadata.x_pos = Math.max(0, this.horizon.obstacles[0].xPos)
      this.metadata.y_pos = Math.max(0, this.horizon.obstacles[0].yPos)
    } catch {/** null during initalization because there is no obstacles. */
      this.metadata.x_pos = 0
      this.metadata.y_pos = 0
    }
    this.metadata.done = this.hp === 0;
  }

  /**
   * Cache the appropriate image sprite from the page and get the sprite sheet
   * definition.
   */
  loadImages() {
    let scale = "1x"
    this.spriteDef = Runner.spriteDefinition.LDPI
    let bdaySpriteDef = Runner.bdaySpriteDefinition.LDPI
    if (IS_HIDPI) {
      scale = "2x"
      this.spriteDef = Runner.spriteDefinition.HDPI
      bdaySpriteDef = Runner.bdaySpriteDefinition.HDPI
    }

    Runner.bdaySpriteDefinition = bdaySpriteDef
    Runner.imageSprite = document.getElementById(RESOURCE_POSTFIX + scale) as HTMLImageElement
    Runner.imageBdaySprite = document.getElementById(BDAY_SPRITE_POSTFIX + scale) as HTMLImageElement

    if (Runner.imageSprite.complete) {
      this.init()
    } else {
      Runner.imageSprite.addEventListener(Runner.events.LOAD, this.init.bind(this))
    }
  }

  /**
   * Load and decode base 64 encoded sounds.
   */
  loadSound() {
    if (!IS_IOS) {
      this.audioContext = new AudioContext()

      for (const sound in Runner.sounds) {
        let soundSrc = (document.getElementById(Runner.sounds[sound]) as HTMLAudioElement).src
        soundSrc = soundSrc.substr(soundSrc.indexOf(",") + 1)
        const buffer = decodeBase64ToArrayBuffer(soundSrc)

        // Async, so no guarantee of order in array.
        this.audioContext.decodeAudioData(buffer, (audioData: AudioBuffer) => {
          this.soundFx[sound] = audioData
        })
      }
    }
  }

  init() {
    this.adjustDimensions()

    // this.containerEl = document.createElement("div")
    this.containerEl = document.querySelector(`.${Runner.classes.CONTAINER}`) as HTMLDivElement
    this.containerEl.setAttribute("role", IS_MOBILE ? "button" : "application")
    this.containerEl.setAttribute("tabindex", "0")
    this.containerEl.className = Runner.classes.CONTAINER

    // const canvas = document.createElement("canvas")
    const canvas = document.querySelector(`.${Runner.classes.CANVAS}`) as HTMLCanvasElement
    canvas.className = Runner.classes.CANVAS
    canvas.width = this.dimensions.WIDTH
    canvas.height = this.dimensions.HEIGHT
    this.canvas = canvas
    // this.containerEl.appendChild(canvas)

    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D
    this.ctx.fillStyle = "#f7f7f7"
    this.ctx.fill()
    Runner.updateCanvasScaling(this.canvas)
    this.outerContainerEl.appendChild(this.containerEl)

    // this.tRex = new Trex(this.canvas, this.spriteDef.TREX)
    this.tRex = new Trex(this.canvas, Runner.bdaySpriteDefinition.TREX)
    this.horizon = new Horizon(this.canvas, this.spriteDef, this.dimensions, this.config.GAP_COEFFICIENT)
    this.distanceMeter = new DistanceMeter(this.canvas, this.spriteDef.TEXT_SPRITE, this.dimensions.WIDTH)
    this.pressToStart = new PressToStart(this.canvas, this.spriteDef.TEXT_SPRITE, this.dimensions)
    this.hpBar = new HPBar(this.canvas, Runner.bdaySpriteDefinition.HP, this.dimensions.WIDTH)

    this.startListening()
    this.update()

    window.addEventListener(Runner.events.RESIZE, this.debounceResize.bind(this))
  }

  /**
   * Debounce the resize event.
   */
  debounceResize() {
    if (!this.resizeTimerId_) {
      this.resizeTimerId_ = setInterval(this.adjustDimensions.bind(this), 250)
    }
  }

  adjustDimensions() {
    this.resizeTimerId_ && clearInterval(this.resizeTimerId_)
    this.resizeTimerId_ = null

    if (typeof window === "undefined") return
    const boxStyles = window.getComputedStyle(this.outerContainerEl)
    const padding = Number(boxStyles.paddingLeft.substr(0, boxStyles.paddingLeft.length - 2))

    this.dimensions.WIDTH = this.outerContainerEl.offsetWidth - padding * 2
    if (this.isArcadeMode()) {
      this.dimensions.WIDTH = Math.min(DEFAULT_WIDTH, this.dimensions.WIDTH)
      if (this.activated) {
        this.setArcadeModeContainerScale()
      }
    }

    if (this.canvas) {
      this.canvas.width = this.dimensions.WIDTH
      this.canvas.height = this.dimensions.HEIGHT

      Runner.updateCanvasScaling(this.canvas)

      this.distanceMeter.calcXPos(this.dimensions.WIDTH)
      this.clearCanvas()
      this.horizon.update(0, 0, true)
      this.tRex.update(0)

      // Outer container and distance meter.
      if (this.playing || this.crashed || this.paused) {
        this.containerEl.style.width = this.dimensions.WIDTH + "px"
        this.containerEl.style.height = this.dimensions.HEIGHT + "px"
        this.stop()
      } else {
        this.tRex.draw(0, 0)
      }

      // Game over panel.
      if (this.crashed && this.gameOverPanel) {
        this.gameOverPanel.updateDimensions(this.dimensions.WIDTH)
        this.gameOverPanel.draw()
      }
    }
  }

  collision = false
  collisionDetection = true
  collisionSilentTimer = 0

  update() {
    this.updatePending = false
    let now = Date.now()
    let deltaTime = now - this.time
    this.time = now

    if (this.playing) {
      this.clearCanvas()

      if (this.tRex.jumping) {
        this.tRex.updateJump(deltaTime)
      }

      this.runningTime += deltaTime
      let hasObstacles = this.runningTime > Runner.config.CLEAR_TIME

      if (!this.playingIntro && this.tRex.jumpCount === 1) {
        this.playIntro()
      }

      // The horizon doesn't move until the intro is over.
      if (this.playingIntro) {
        this.horizon.update(0, this.currentSpeed, hasObstacles)
      } else if (!this.crashed) {
        deltaTime = !this.activated ? 0 : deltaTime
        this.horizon.update(deltaTime, this.currentSpeed, hasObstacles, this.inverted)
      }

      // Check for collisions.
      this.collisionSilentTimer += deltaTime
      const collision = hasObstacles && checkForCollision(this.horizon.obstacles[0], this.tRex)
      let disableDetection = this.collisionSilentTimer < Runner.config.COLLISION_DETECTION_SILENT_DURATION

      if (!collision) {
        this.distanceRan += (this.currentSpeed / this.msPerFrame) * deltaTime

        if (this.currentSpeed < this.config.MAX_SPEED) {
          this.currentSpeed += this.config.ACCELERATION
        }
      } else if (!disableDetection) {
        this.collisionSilentTimer = 0

        if (this.collision !== !!collision) {
          if (collision.type === "HP") {
            this.hp = Math.min(this.hp + 1, HPBar.config.MAX_HP)
          } else if (this.hp - 1 > 0) {
            this.hp -= 1
            this.playSound(this.soundFx.HIT)
          } else {
            this.hp = 0
            this.gameOver()
          }
        }
      }

      this.collision = !!collision
      this.hpBar.update(deltaTime, this.hp)

      let playAchievementSound = this.distanceMeter.update(deltaTime, Math.ceil(this.distanceRan))

      if (playAchievementSound) {
        this.playSound(this.soundFx.SCORE)
      }

      // Night mode.
      if (this.inverTimer > this.config.INVERT_FADE_DURATION) {
        // 夜晚模式结束
        this.inverTimer = 0
        this.invertTrigger = false
        this.invert(false)
      } else if (this.inverTimer) {
        // 处于夜晚模式，更新其时间
        this.inverTimer += deltaTime
      } else {
        // 还没进入夜晚模式
        // 游戏移动的距离
        const actualDistance = this.distanceMeter.getActualDistance(Math.ceil(this.distanceRan))

        if (actualDistance > 0) {
          // 每移动指定距离就触发一次夜晚模式
          this.invertTrigger = !(actualDistance % this.config.INVERT_DISTANCE)

          if (this.invertTrigger && this.inverTimer === 0) {
            this.inverTimer += deltaTime
            this.invert(false)
          }
        }
      }
    }

    if (!this.activated) {
      this.ctx.clearRect(0, 0, this.dimensions.WIDTH, this.dimensions.HEIGHT - 80)
      this.tRex.update(deltaTime)
      this.pressToStart.update(deltaTime)

      this.scheduleNextUpdate()
      return
    } else {
      this.pressToStart.update(deltaTime, true)
    }

    if (this.playing || (!this.activated && this.tRex.blinkCount < Runner.config.MAX_BLINK_COUNT)) {
      this.tRex.update(deltaTime)

      this.scheduleNextUpdate()
    }
    this._store_observation()
  }

  /**
   * RequestAnimationFrame wrapper.
   */
  scheduleNextUpdate() {
    if (!this.updatePending) {
      this.updatePending = true
      this.raqId = requestAnimationFrame(this.update.bind(this))
    }
  }

  /**
   * Play the game intro.
   * Canvas container width expands out to the full width.
   */
  playIntro() {
    if (!this.activated && !this.crashed) {
      this.playingIntro = true
      this.tRex.playingIntro = true

      const messageEl = document.querySelector("#main-message") as HTMLDivElement
      messageEl.style.opacity = "0"

      // let keyframes = `@-webkit-keyframes intro {
      //     from { width: ${Trex.config.WIDTH}px }
      //     to { width: ${this.dimensions.WIDTH}px } +
      //   }`
      let keyframes = `@-webkit-keyframes intro {}`
      document.styleSheets[0].insertRule(keyframes, 0)
      this.containerEl.style.webkitAnimation = "intro .4s ease-out 1 both"
      this.containerEl.style.width = this.dimensions.WIDTH + "px"
      this.containerEl.addEventListener(Runner.events.ANIM_END, this.startGame.bind(this))

      this.setPlayStatus(true)
      this.activated = true
    } else if (this.crashed) {
      this.restart()
    }
  }

  /**
   * Update the game status to started.
   */
  startGame() {
    // TODO: Uncomment to enable fullscreen
    // if (this.isArcadeMode()) {
    //   this.setArcadeMode()
    // }

    this.tRex.playingIntro = false
    this.runningTime = 0
    this.playingIntro = false
    this.containerEl.style.webkitAnimation = ""

    window.addEventListener(Runner.events.BLUR, this.onVisibilityChange.bind(this))
    window.addEventListener(Runner.events.FOCUS, this.onVisibilityChange.bind(this))
  }

  restart() {
    if (!this.raqId) {
      this.runningTime = 0
      this.setPlayStatus(true)
      this.paused = false
      this.crashed = false
      this.gameOverPanel.reset()

      this.hpBar.reset()
      this.hp = HPBar.config.MAX_HP
      this.collision = false
      this.collision = false
      this.collisionDetection = true
      this.collisionSilentTimer = 0

      this.distanceRan = 0
      this.currentSpeed = this.config.SPEED
      this.time = Date.now()
      this.clearCanvas()
      this.distanceMeter.reset()
      this.horizon.reset()
      this.tRex.reset()
      this.invert(true)
      this.update()
    }
  }

  gameOver() {
    this.playSound(this.soundFx.HIT)
    this.stop()
    this.crashed = true
    this.distanceMeter.achievement = false

    this.hpBar.update(0, this.hp)
    this.tRex.update(100, Trex.status.CRASHED)

    if (!this.gameOverPanel) {
      this.gameOverPanel = new GameOverPanel(
        this.canvas,
        this.spriteDef.TEXT_SPRITE,
        this.spriteDef.RESTART,
        this.dimensions
      )
    } else {
      this.gameOverPanel.draw()
    }

    // Update the high score.
    if (this.distanceRan > this.highestScore) {
      this.highestScore = Math.ceil(this.distanceRan)
      this.distanceMeter.setHighScore(this.highestScore)
    }

    this.time = Date.now()
  }

  clearCanvas() {
    this.ctx.clearRect(0, 0, this.dimensions.WIDTH, this.dimensions.HEIGHT)
  }

  setPlayStatus(playing: boolean) {
    this.playing = playing
  }

  isArcadeMode() {
    return true
  }

  /** Hides offline messaging for a fullscreen game only experience. */
  setArcadeMode() {
    document.body.classList.add(Runner.classes.ARCADE_MODE)
    this.setArcadeModeContainerScale()
  }

  /** Set arcade mode container scaling when start acade mode  */
  setArcadeModeContainerScale() {
    let windowHeight = window.innerHeight
    let scaleHeight = windowHeight / this.dimensions.HEIGHT
    let scaleWidth = window.innerWidth / this.dimensions.WIDTH
    let scale = Math.max(1, Math.min(scaleHeight, scaleWidth))
    let scaledCanvasHeight = this.dimensions.HEIGHT * scale

    let translateY =
      Math.ceil(
        Math.max(
          0,
          (windowHeight - scaledCanvasHeight - Runner.config.ARCADE_MODE_INITIAL_TOP_POSITION) *
          Runner.config.ARCADE_MODE_TOP_POSITION_PERCENT
        )
      ) * window.devicePixelRatio
    this.containerEl.style.transform = "scale(" + scale + ") translateY(" + translateY + "px)"
  }

  /**
   * Inverts the current page / canvas colors.
   */
  invert(reset: boolean) {
    const htmlEl = document.firstElementChild

    if (reset) {
      htmlEl?.classList.toggle(Runner.classes.INVERTED, false)
      this.inverTimer = 0
      this.inverted = false
    } else {
      this.inverted = htmlEl?.classList.toggle(Runner.classes.INVERTED, this.invertTrigger)!
    }
  }

  /**
   * Play a sound.
   */
  playSound(soundBuffer?: AudioBuffer) {
    if (soundBuffer) {
      let sourceNode = this.audioContext.createBufferSource()
      sourceNode.buffer = soundBuffer
      sourceNode.connect(this.audioContext.destination)
      sourceNode.start(0)
    }
  }

  onVisibilityChange(e: Event) {
    console.log(e.type)
    if (document.hidden || e.type === Runner.events.BLUR || document.visibilityState != "visible") {
      this.stop()
    } else if (!this.crashed) {
      this.play()
    }
  }

  /** Listen to events */
  startListening() {
    // Keys.
    document.addEventListener(Runner.events.KEYDOWN, this)
    document.addEventListener(Runner.events.KEYUP, this)

    // Touch / pointer.
    document.addEventListener(Runner.events.TOUCHSTART, this)
    document.addEventListener(Runner.events.TOUCHEND, this)
    document.addEventListener(Runner.events.POINTERDOWN, this)
    document.addEventListener(Runner.events.POINTERUP, this)
  }

  stopListening() {
    // Keys.
    document.removeEventListener(Runner.events.KEYDOWN, this)
    document.removeEventListener(Runner.events.KEYUP, this)

    // Touch / pointer.
    document.removeEventListener(Runner.events.TOUCHSTART, this)
    document.removeEventListener(Runner.events.TOUCHEND, this)
    document.removeEventListener(Runner.events.POINTERDOWN, this)
    document.removeEventListener(Runner.events.POINTERUP, this)
  }

  /** addEventListener default method */
  handleEvent = (e: KeyboardEvent) => {
    const evtType = e.type
    switch (evtType) {
      case Runner.events.KEYDOWN:
      case Runner.events.TOUCHSTART:
      case Runner.events.POINTERDOWN:
        this.onKeydown(e)
        break
      case Runner.events.KEYUP:
      case Runner.events.TOUCHEND:
      case Runner.events.POINTERUP:
        this.onKeyUp(e)
        break
    }
  }

  onKeydown(e: KeyboardEvent) {
    if (IS_MOBILE && this.playing) {
      e.preventDefault()
    }

    const keycode = e.keyCode
    const isJumpKey =
      Runner.keycodes.JUMP[keycode] || e.type === Runner.events.TOUCHSTART || e.type === Runner.events.POINTERDOWN
    if (!this.crashed && !this.paused) {
      if (isJumpKey) {
        if (!this.playing) {
          this.loadSound()
          this.setPlayStatus(true)
          this.update()
        }

        if (!this.tRex.jumping && !this.tRex.ducking) {
          this.playSound(this.soundFx.BUTTON_PRESS)
          this.tRex.startJump(this.currentSpeed)
        }
      } else if (this.playing && Runner.keycodes.DUCK[keycode]) {
        if (this.tRex.jumping) {
          this.tRex.setSpeedDrop()
        } else if (!this.tRex.jumping && !this.tRex.ducking) {
          this.tRex.setDuck(true)
        }
      }
    }
  }

  onKeyUp(e: KeyboardEvent) {
    const keycode = e.keyCode
    const isJumpKey =
      Runner.keycodes.JUMP[keycode] || e.type === Runner.events.TOUCHEND || e.type === Runner.events.POINTERUP
      if (this.isRunning() && isJumpKey) {
      this.tRex.endJump()
    } else if (Runner.keycodes.DUCK[keycode]) {
      this.tRex.speedDrop = false
      this.tRex.setDuck(false)
    } else if (this.crashed) {
      let deltaTime = Date.now() - this.time

      if (
        deltaTime >= this.config.GAMEOVER_CLEAR_TIME &&
        (Runner.keycodes.JUMP[keycode] || Runner.keycodes.RESTART[keycode] || e.type === Runner.events.POINTERUP || e.type === Runner.events.TOUCHEND)
      ) {
        this.restart()
      }
    } else if (this.paused && isJumpKey) {
      this.tRex.reset()
      this.play()
    }
  }

  isRunning() {
    return !!this.raqId
  }

  stop() {
    this.setPlayStatus(false)
    this.paused = true
    cancelAnimationFrame(this.raqId)
    this.raqId = 0
  }

  play() {
    if (!this.crashed) {
      this.setPlayStatus(true)
      this.paused = false
      this.time = Date.now()
      this.update()
      this.tRex.reset()
    }
  }

  private static _instance: Runner

  static getInstance(outerContainerId: string, optConfig?: any) {
    if (Runner._instance) {
      Runner._instance.init()
      return Runner._instance
    }
    Runner._instance = new Runner(outerContainerId, optConfig)
    return Runner._instance
  }

  /** Default canvas dimensions */
  static defaultDimensions = {
    WIDTH: 600,
    HEIGHT: 150
  }

  /**
   * Update canvas scale based on devicePixelRatio
   */
  static updateCanvasScaling(canvas: HTMLCanvasElement, opt_width?: number, opt_height?: number) {
    const context = canvas.getContext("2d") as CanvasRenderingContext2D
    // Query the various pixel ratios
    const devicePixelRatio = Math.floor(window.devicePixelRatio) || 1
    const backingStoreRatio = 1
    const ratio = devicePixelRatio / backingStoreRatio

    // Upscale the canvas if the two ratios don't match
    if (devicePixelRatio !== backingStoreRatio) {
      const oldWidth = opt_width || canvas.width
      const oldHeight = opt_height || canvas.height

      canvas.width = oldWidth * ratio
      canvas.height = oldHeight * ratio

      canvas.style.width = oldWidth + "px"
      canvas.style.height = oldHeight + "px"

      // Scale the context to counter the fact that we've manually scaled
      // our canvas element.
      context.scale(ratio, ratio)
      return true
    } else if (devicePixelRatio === 1) {
      // Reset the canvas width / height. Fixes scaling bug when the page is
      // zoomed and the devicePixelRatio changes accordingly.
      canvas.style.width = canvas.width + "px"
      canvas.style.height = canvas.height + "px"
    }
    return false
  }

  static events = {
    ANIM_END: "webkitAnimationEnd",
    CLICK: "click",
    KEYDOWN: "keydown",
    KEYUP: "keyup",
    POINTERDOWN: "pointerdown",
    POINTERUP: "pointerup",
    RESIZE: "resize",
    TOUCHEND: "touchend",
    TOUCHSTART: "touchstart",
    VISIBILITY: "visibilitychange",
    BLUR: "blur",
    FOCUS: "focus",
    LOAD: "load",
    GAMEPADCONNECTED: "gamepadconnected"
  }

  static classes = {
    ARCADE_MODE: "arcade-mode",
    CANVAS: "runner-canvas",
    CONTAINER: "runner-container",
    CRASHED: "crashed",
    ICON: "icon-offline",
    INVERTED: "inverted",
    SNACKBAR: "snackbar",
    SNACKBAR_SHOW: "snackbar-show",
    TOUCH_CONTROLLER: "controller"
  }

  /**
   * Sound FX. Reference to the ID of the audio tag on interstitial page.
   */
  static sounds: ConfigDict = {
    BUTTON_PRESS: "offline-sound-press",
    HIT: "offline-sound-hit",
    SCORE: "offline-sound-reached"
  }

  static keycodes = {
    JUMP: { 38: 1, 32: 1 } as any, // Up, spacebar
    DUCK: { 40: 1 } as any, // Down
    RESTART: { 13: 1 } as any // Enter
  }

  /**
   * Default game configuration.
   * Shared config for all  versions of the game. Additional parameters are
   * defined in Runner.normalConfig and Runner.slowConfig.
   */
  static config = {
    AUDIOCUE_PROXIMITY_THRESHOLD: 190,
    AUDIOCUE_PROXIMITY_THRESHOLD_MOBILE_A11Y: 250,
    BG_CLOUD_SPEED: 0.2,
    BOTTOM_PAD: 10,
    // Scroll Y threshold at which the game can be activated.
    CANVAS_IN_VIEW_OFFSET: -10,
    CLEAR_TIME: 3000,
    CLOUD_FREQUENCY: 0.5,
    FADE_DURATION: 1,
    FLASH_DURATION: 1000,
    GAMEOVER_CLEAR_TIME: 1200,
    INITIAL_JUMP_VELOCITY: 12,
    INVERT_FADE_DURATION: 12000,
    MAX_BLINK_COUNT: Infinity,
    MAX_CLOUDS: 6,
    MAX_OBSTACLE_LENGTH: 3,
    MAX_OBSTACLE_DUPLICATION: 2,
    RESOURCE_TEMPLATE_ID: "audio-resources",
    SPEED: 6,
    SPEED_DROP_COEFFICIENT: 3,
    ARCADE_MODE_INITIAL_TOP_POSITION: 35,
    ARCADE_MODE_TOP_POSITION_PERCENT: 0.1,
    COLLISION_DETECTION_SILENT_DURATION: 825
  }

  static normalConfig = {
    ACCELERATION: 0.001,
    AUDIOCUE_PROXIMITY_THRESHOLD: 190,
    AUDIOCUE_PROXIMITY_THRESHOLD_MOBILE_A11Y: 250,
    GAP_COEFFICIENT: 0.6,
    INVERT_DISTANCE: 700,
    MAX_SPEED: 13,
    MOBILE_SPEED_COEFFICIENT: 1.2,
    SPEED: 6
  }

  static imageSprite: HTMLImageElement
  static imageBdaySprite: HTMLImageElement

  static spriteDefinition = {
    LDPI: {
      BACKGROUND_EL: { x: 86, y: 2 },
      CACTUS_LARGE: { x: 332, y: 2 },
      CACTUS_SMALL: { x: 228, y: 2 },
      OBSTACLE_2: { x: 332, y: 2 },
      OBSTACLE: { x: 228, y: 2 },
      CLOUD: { x: 86, y: 2 },
      HORIZON: { x: 2, y: 54 },
      MOON: { x: 484, y: 2 },
      PTERODACTYL: { x: 134, y: 2 },
      RESTART: { x: 2, y: 68 },
      TEXT_SPRITE: { x: 655, y: 2 },
      TREX: { x: 848, y: 2 },
      STAR: { x: 645, y: 2 },
      COLLECTABLE: { x: 2, y: 2 },
      ALT_GAME_END: { x: 121, y: 2 }
    },
    HDPI: {
      BACKGROUND_EL: { x: 166, y: 2 },
      CACTUS_LARGE: { x: 652, y: 2 },
      CACTUS_SMALL: { x: 446, y: 2 },
      OBSTACLE_2: { x: 652, y: 2 },
      OBSTACLE: { x: 446, y: 2 },
      CLOUD: { x: 166, y: 2 },
      HORIZON: { x: 2, y: 104 },
      MOON: { x: 954, y: 2 },
      PTERODACTYL: { x: 260, y: 2 },
      RESTART: { x: 2, y: 130 },
      TEXT_SPRITE: { x: 1294, y: 2 },
      TREX: { x: 1678, y: 2 },
      STAR: { x: 1276, y: 2 },
      COLLECTABLE: { x: 4, y: 4 },
      ALT_GAME_END: { x: 242, y: 4 }
    },
    MAX_GAP_COEFFICIENT: 1.5,
    MAX_OBSTACLE_LENGTH: 3,
    HAS_CLOUDS: 1,
    BOTTOM_PAD: 10,
    TREX: {
      WAITING_1: { x: 44, w: 44, h: 47, xOffset: 0 },
      WAITING_2: { x: 0, w: 44, h: 47, xOffset: 0 },
      RUNNING_1: { x: 88, w: 44, h: 47, xOffset: 0 },
      RUNNING_2: { x: 132, w: 44, h: 47, xOffset: 0 },
      JUMPING: { x: 0, w: 44, h: 47, xOffset: 0 },
      CRASHED: { x: 220, w: 44, h: 47, xOffset: 0 }
    },
    BACKGROUND_EL: {
      CLOUD: {
        HEIGHT: 14,
        MAX_CLOUD_GAP: 400,
        MAX_SKY_LEVEL: 30,
        MIN_CLOUD_GAP: 100,
        MIN_SKY_LEVEL: 71,
        OFFSET: 4,
        WIDTH: 46,
        X_POS: 1,
        Y_POS: 120
      }
    },
    BACKGROUND_EL_CONFIG: {
      MAX_BG_ELS: 1,
      MAX_GAP: 400,
      MIN_GAP: 100,
      POS: 0,
      SPEED: 0.5,
      Y_POS: 125
    },
    LINES: [{ SOURCE_X: 2, SOURCE_Y: 52, WIDTH: 600, HEIGHT: 12, YPOS: 127 }]
  }

  static bdaySpriteDefinition: any = {
    LDPI: {
      TREX: { x: 0, y: 0 },
      BIRTHDAY_CAKE: { x: 384, y: 23 },
      BALLOON: { x: 417, y: 29 },
      HP: { x: 433, y: 37 },
      MOUNTAIN: { x: 0, y: 65 }
    },
    HDPI: {
      TREX: { x: 0, y: 0 },
      BIRTHDAY_CAKE: { x: 768, y: 46 },
      BALLOON: { x: 834, y: 58 },
      HP: { x: 866, y: 74 },
      MOUNTAIN: { x: 0, y: 130 }
    }
  }
}

/**
 * Decodes the base 64 audio to ArrayBuffer used by Web Audio.
 * @param {string} base64String
 */
function decodeBase64ToArrayBuffer(base64String: string) {
  const len = (base64String.length / 4) * 3
  const str = atob(base64String)
  const arrayBuffer = new ArrayBuffer(len)
  const bytes = new Uint8Array(arrayBuffer)

  for (let i = 0; i < len; i++) {
    bytes[i] = str.charCodeAt(i)
  }
  return bytes.buffer
}
