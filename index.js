/**
 * DVDthèque — Cloud Function OCR (Google Cloud Vision)
 *
 * Reçoit une image (base64) depuis la PWA, la fait analyser par
 * Google Cloud Vision (détection de texte), et renvoie les lignes
 * détectées triées. CORS activé pour autoriser l'appel depuis
 * la PWA GitHub Pages.
 *
 * Endpoint : POST { image: "data:image/...;base64,...." }
 * Réponse  : { fullText: "...", lines: ["...", "..."] }
 */

const { onRequest } = require("firebase-functions/v2/https");
const vision = require("@google-cloud/vision");

// Client Vision (utilise les identifiants du projet automatiquement)
const client = new vision.ImageAnnotatorClient();

exports.ocr = onRequest(
  { cors: true, region: "europe-west1", memory: "512MiB", timeoutSeconds: 30 },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Méthode non autorisée" });
      }
      let image = req.body && req.body.image;
      if (!image) {
        return res.status(400).json({ error: "Image manquante" });
      }
      // Retire le préfixe data:image/...;base64, si présent
      const comma = image.indexOf(",");
      if (image.startsWith("data:") && comma !== -1) {
        image = image.slice(comma + 1);
      }

      // Appel Vision : détection de texte
      const [result] = await client.textDetection({
        image: { content: image },
      });

      const annotation = result.fullTextAnnotation;
      const fullText = annotation ? annotation.text : "";

      // Construit des "lignes" candidates à partir des blocs Vision,
      // avec leur taille (hauteur) pour repérer le titre (gros texte).
      const candidates = [];
      if (annotation && annotation.pages) {
        for (const page of annotation.pages) {
          for (const block of page.blocks || []) {
            for (const para of block.paragraphs || []) {
              const words = (para.words || []).map((w) =>
                (w.symbols || []).map((s) => s.text).join("")
              );
              const text = words.join(" ").replace(/\s+/g, " ").trim();
              if (text.length < 2) continue;
              // Hauteur approximative du paragraphe (pour le tri par taille)
              const box = para.boundingBox && para.boundingBox.vertices;
              let h = 0;
              if (box && box.length >= 4) {
                h = Math.abs((box[3].y || 0) - (box[0].y || 0));
              }
              candidates.push({ text, h });
            }
          }
        }
      }
      // Tri par hauteur décroissante (le titre est généralement le plus gros)
      candidates.sort((a, b) => b.h - a.h);
      const lines = [];
      const seen = new Set();
      for (const c of candidates) {
        const k = c.text.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        lines.push(c.text);
        if (lines.length >= 8) break;
      }

      return res.status(200).json({ fullText, lines });
    } catch (e) {
      console.error("Erreur OCR Vision:", e);
      return res.status(500).json({ error: String(e.message || e) });
    }
  }
);
