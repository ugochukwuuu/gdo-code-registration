import layout from './ticket-layout.json'

const asset = path => new URL(import.meta.env.BASE_URL + path, document.baseURI).href

function loadTemplate() {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('The original ticket image could not be loaded. Please try again.'))
    image.src = asset(layout.template)
  })
}

function drawField(context, field, text) {
  const { x, y, width, height, color, fontFamily, fontWeight = 400, align = 'left', rotate = 0 } = field
  if (![x, y, width, height, field.fontSize].every(Number.isFinite) || width <= 0 || height <= 0 ||
      field.fontSize <= 0 || x < 0 || y < 0 || x + width > context.canvas.width ||
      y + height > context.canvas.height || !['left', 'center', 'right'].includes(align) || !color || !fontFamily) {
    throw new Error('The ticket text positions need to be configured.')
  }

  context.save()
  context.beginPath()
  context.rect(x, y, width, height)
  context.clip()
  if (field.clear) {
    const { x: clearX, y: clearY, width: clearWidth, height: clearHeight, sampleX, sampleY } = field.clear
    const [red, green, blue] = context.getImageData(sampleX, sampleY, 1, 1).data
    context.fillStyle = 'rgb(' + red + ', ' + green + ', ' + blue + ')'
    context.fillRect(clearX, clearY, clearWidth, clearHeight)
  }
  const lineWidth = rotate ? height : width
  const lineHeight = rotate ? width : height
  context.translate(x + width / 2, y + height / 2)
  context.rotate(rotate * Math.PI / 180)
  context.fillStyle = color
  context.textAlign = align
  context.textBaseline = 'middle'
  context.direction = 'ltr'

  const label = field.uppercase ? text.toUpperCase() : text
  let size = Math.min(field.fontSize, lineHeight)
  context.font = fontWeight + ' ' + size + 'px ' + fontFamily
  const measured = context.measureText(label).width
  if (measured > lineWidth) {
    size *= lineWidth / measured
    context.font = fontWeight + ' ' + size + 'px ' + fontFamily
  }
  const anchor = align === 'center' ? 0 : align === 'right' ? lineWidth / 2 : -lineWidth / 2
  context.fillText(label, anchor, 0, lineWidth)
  context.restore()
}

export async function renderTicket(ticket) {
  if (!layout.name || !layout.number) {
    throw new Error('Your registration is saved. The organiser still needs to configure the original ticket artwork.')
  }
  const [image] = await Promise.all([
    loadTemplate(),
    ...layout.fontFiles.map(async ({ family, path, weight = '400' }) => {
      const font = await new FontFace(family, 'url("' + asset(path) + '")', { weight }).load()
      document.fonts.add(font)
    }),
  ])
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not prepare the ticket. Please try again.')
  context.drawImage(image, 0, 0)
  drawField(context, layout.name, ticket.fullName)
  drawField(context, layout.number, ticket.ticketNumber)
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('The ticket PNG could not be created. Please try again.'))
    }, 'image/png')
  })
}
