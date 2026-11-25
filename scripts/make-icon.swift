import AppKit
import Foundation

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon-1024.png"
let size: CGFloat = 1024

let rep = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(size),
  pixelsHigh: Int(size),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
)!

NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
let cg = ctx.cgContext

// macOS icon inset + rounded squircle
let inset: CGFloat = 92
let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let radius: CGFloat = 190
let rounded = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

// Subtle drop shadow
cg.saveGState()
cg.setShadow(offset: CGSize(width: 0, height: -18), blur: 34, color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.45))
cg.addPath(rounded)
cg.setFillColor(CGColor(red: 0.06, green: 0.075, blue: 0.10, alpha: 1.0))
cg.fillPath()
cg.restoreGState()

// Clip to squircle for interior gradients
cg.saveGState()
cg.addPath(rounded)
cg.clip()

let cs = CGColorSpaceCreateDeviceRGB()
let bgGrad = CGGradient(
  colorsSpace: cs,
  colors: [
    CGColor(red: 0.11, green: 0.135, blue: 0.19, alpha: 1.0),
    CGColor(red: 0.055, green: 0.067, blue: 0.09, alpha: 1.0),
  ] as CFArray,
  locations: [0.0, 1.0]
)!
cg.drawLinearGradient(bgGrad, start: CGPoint(x: size / 2, y: size - inset), end: CGPoint(x: size / 2, y: inset), options: [])

// Subtle top-left blue-violet ambient glow
let glowGrad = CGGradient(
  colorsSpace: cs,
  colors: [
    CGColor(red: 0.42, green: 0.55, blue: 1.0, alpha: 0.28),
    CGColor(red: 0.42, green: 0.55, blue: 1.0, alpha: 0.0),
  ] as CFArray,
  locations: [0.0, 1.0]
)!
cg.drawRadialGradient(
  glowGrad,
  startCenter: CGPoint(x: 340, y: 740),
  startRadius: 10,
  endCenter: CGPoint(x: 340, y: 740),
  endRadius: 460,
  options: []
)

// Sidebar divider strip on the left (subtle nod to termdeck's sidebar!)
let sidebarRect = CGRect(x: inset, y: inset, width: 210, height: size - inset * 2)
cg.setFillColor(CGColor(red: 0.08, green: 0.10, blue: 0.14, alpha: 0.85))
cg.fill(sidebarRect)

// Divider line
cg.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.09))
cg.setLineWidth(4)
cg.move(to: CGPoint(x: inset + 210, y: inset))
cg.addLine(to: CGPoint(x: inset + 210, y: size - inset))
cg.strokePath()

// Three tiny session pills in the sidebar
let dotColors: [CGColor] = [
  CGColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 0.95), // Claude coral
  CGColor(red: 0.42, green: 0.55, blue: 1.0, alpha: 0.95),  // Antigravity blue
  CGColor(red: 0.20, green: 0.83, blue: 0.60, alpha: 0.90), // Active green
]
for (idx, col) in dotColors.enumerated() {
  let y = size - inset - 210 - CGFloat(idx) * 86
  let pill = CGRect(x: inset + 36, y: y, width: 138, height: 48)
  let pillPath = CGPath(roundedRect: pill, cornerWidth: 16, cornerHeight: 16, transform: nil)
  cg.addPath(pillPath)
  cg.setFillColor(idx == 1 ? CGColor(red: 0.42, green: 0.55, blue: 1.0, alpha: 0.22) : CGColor(red: 1, green: 1, blue: 1, alpha: 0.06))
  cg.fillPath()

  cg.setFillColor(col)
  cg.fillEllipse(in: CGRect(x: inset + 54, y: y + 15, width: 18, height: 18))
}

// Crisp ">_" terminal mark on the right pane
cg.setLineCap(.round)
cg.setLineJoin(.round)
cg.setLineWidth(54)
cg.setStrokeColor(CGColor(red: 0.48, green: 0.62, blue: 1.0, alpha: 1.0))

let baseX: CGFloat = inset + 345
let centerY: CGFloat = size * 0.49
cg.move(to: CGPoint(x: baseX, y: centerY + 105))
cg.addLine(to: CGPoint(x: baseX + 135, y: centerY))
cg.addLine(to: CGPoint(x: baseX, y: centerY - 105))
cg.strokePath()

cg.setStrokeColor(CGColor(red: 0.90, green: 0.93, blue: 0.98, alpha: 0.95))
cg.move(to: CGPoint(x: baseX + 195, y: centerY - 105))
cg.addLine(to: CGPoint(x: baseX + 355, y: centerY - 105))
cg.strokePath()

cg.restoreGState()

// Crisp inner hairline border
cg.addPath(rounded)
cg.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.14))
cg.setLineWidth(5)
cg.strokePath()

NSGraphicsContext.restoreGraphicsState()

let png = rep.representation(using: .png, properties: [:])!
try png.write(to: URL(fileURLWithPath: outPath))
print("Wrote \(outPath)")
