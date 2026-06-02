import Foundation
import Capacitor
import UIKit

/**
 * PdfExport — render an HTML document to a PDF via UIKit's print renderer (the
 * real WebKit-backed markup renderer, so vertical-rl + <ruby> lay out
 * correctly), then present the native share sheet so the user can email it,
 * save to Files, or AirPrint. `window.print()` is a no-op in WKWebView, which
 * is why JS-side printing did nothing on iOS.
 *
 * JS: PdfExport.share({ html, fileName, title })
 */
@objc(PdfExportPlugin)
public class PdfExportPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "PdfExportPlugin"
    public let jsName = "PdfExport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "share", returnType: CAPPluginReturnPromise),
    ]

    @objc func share(_ call: CAPPluginCall) {
        guard let html = call.getString("html"), !html.isEmpty else {
            call.reject("html required"); return
        }
        // Keep Unicode (Japanese titles); strip only filesystem-illegal chars.
        let illegal = CharacterSet(charactersIn: "/\\:*?\"<>|")
        var fileName = (call.getString("fileName") ?? "reading").components(separatedBy: illegal).joined()
        if fileName.trimmingCharacters(in: .whitespaces).isEmpty { fileName = "reading" }

        DispatchQueue.main.async {
            // US Letter landscape @ 72pt/in → 11in x 8.5in = 792 x 612 points.
            let paperRect = CGRect(x: 0, y: 0, width: 792, height: 612)
            // Use the FULL sheet as the printable area. The HTML draws its own
            // margins (each .pr-sheet is ~10.6×8.0in with internal padding); a
            // 36pt inset here shrank the usable area to 10×7.5in, smaller than
            // the sheet, so every sheet overflowed onto a blank page. (CSS @page
            // is ignored by UIMarkupTextPrintFormatter — only this rect counts.)
            let printableRect = paperRect

            let formatter = UIMarkupTextPrintFormatter(markupText: html)
            let renderer = UIPrintPageRenderer()
            renderer.addPrintFormatter(formatter, startingAtPageAt: 0)
            // UIPrintPageRenderer exposes these only via KVC; KVC needs the
            // CGRects boxed as NSValue (a raw CGRect would crash at runtime).
            renderer.setValue(NSValue(cgRect: paperRect), forKey: "paperRect")
            renderer.setValue(NSValue(cgRect: printableRect), forKey: "printableRect")

            let pdfData = NSMutableData()
            UIGraphicsBeginPDFContextToData(pdfData, paperRect, nil)
            let pageCount = max(1, renderer.numberOfPages)
            renderer.prepare(forDrawingPages: NSRange(location: 0, length: pageCount))
            let bounds = UIGraphicsGetPDFContextBounds()
            for i in 0..<pageCount {
                UIGraphicsBeginPDFPage()
                renderer.drawPage(at: i, in: bounds)
            }
            UIGraphicsEndPDFContext()

            let url = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("\(fileName).pdf")
            do {
                try pdfData.write(to: url, options: .atomic)
            } catch {
                call.reject("PDF write failed: \(error.localizedDescription)"); return
            }

            guard let vc = self.bridge?.viewController else {
                call.reject("No view controller to present from"); return
            }
            let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            // iPad requires a popover anchor.
            if let pop = activity.popoverPresentationController {
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 0, height: 0)
                pop.permittedArrowDirections = []
            }
            activity.completionWithItemsHandler = { _, completed, _, _ in
                call.resolve(["shared": completed])
            }
            vc.present(activity, animated: true, completion: nil)
        }
    }
}
