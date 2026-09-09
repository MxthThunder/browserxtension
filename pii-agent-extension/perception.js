/**
 * Unified Perception Layer (Step 1 - ISRO Privacy Browser Agent)
 * 
 * Aggregates, normalizes, and fuses multi-modal signals:
 *   1. DOM Inspection (Interactive inputs, buttons, text nodes, Shadow DOM, ARIA)
 *   2. OWL-ViT (Zero-shot visual physical object & credential detection)
 *   3. MediaPipe BlazeFace (High-precision biometric face detection)
 *   4. Tesseract OCR (On-screen text & regex pattern recognition)
 * 
 * Produces a single, coherent UnifiedPerceptionState with normalized bounding boxes,
 * deduplicated entities, semantic roles, and PII classifications.
 */

/**
 * Standard semantic roles for unified elements
 */
export const SEMANTIC_ROLES = {
  // Sensitive Roles
  EMAIL_FIELD: "email_field",
  PASSWORD_FIELD: "password_field",
  USERNAME_FIELD: "username_field",
  CREDIT_CARD_FIELD: "credit_card_field",
  CVV_FIELD: "cvv_field",
  EXPIRY_FIELD: "expiry_field",
  GOV_ID_FIELD: "gov_id_field",
  PHONE_FIELD: "phone_field",
  NAME_FIELD: "name_field",
  ADDRESS_FIELD: "address_field",
  BIOMETRIC_FACE: "biometric_face",
  PHYSICAL_CREDENTIAL: "physical_credential",
  SENSITIVE_TEXT: "sensitive_text",
  CONFIDENTIAL_DOC: "confidential_document",
  FILE_UPLOAD: "file_upload",

  // Interactive Non-Sensitive Roles
  BUTTON: "button",
  LINK: "link",
  SELECT: "select",
  CHECKBOX: "checkbox",
  RADIO: "radio",
  TEXT_INPUT: "text_input",
  SEARCH_INPUT: "search_input",
  TEXT_CONTENT: "text_content",
  GENERIC_INTERACTIVE: "generic_interactive",
};

/**
 * Computes Intersection over Union (IoU) between two bounding boxes {x, y, w, h}.
 */
export function computeIoU(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix1 = Math.max(a.x, b.x), iy1 = Math.max(a.y, b.y);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter === 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Computes containment ratio (how much of box A is inside box B).
 */
export function computeContainment(inner, outer) {
  const ix1 = Math.max(inner.x, outer.x);
  const iy1 = Math.max(inner.y, outer.y);
  const ix2 = Math.min(inner.x + inner.w, outer.x + outer.w);
  const iy2 = Math.min(inner.y + inner.h, outer.y + outer.h);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const innerArea = inner.w * inner.h;
  return innerArea > 0 ? inter / innerArea : 0;
}

/**
 * Determines a granular semantic role from DOM element metadata and classification.
 */
export function determineSemanticRole(domData, ocrData, visionData) {
  // 1. Check if face detection
  if (visionData?.source === "MediaPipe-Face" || visionData?.label === "Face") {
    return SEMANTIC_ROLES.BIOMETRIC_FACE;
  }

  // 2. Check OWL-ViT visual physical objects
  if (visionData?.label || visionData?.category || visionData?.source === "OWL-ViT" || visionData?.source === "OWL-ViT-ZeroShot") {
    const label = (visionData.label || visionData.category || "").toLowerCase();
    if (/card|credit|debit|bank/i.test(label)) return SEMANTIC_ROLES.PHYSICAL_CREDENTIAL;
    if (/passport|license|aadhaar|pan|identity|national/i.test(label)) return SEMANTIC_ROLES.PHYSICAL_CREDENTIAL;
    if (/record|statement|document|cheque/i.test(label)) return SEMANTIC_ROLES.CONFIDENTIAL_DOC;
    if (/screen|monitor|laptop|phone/i.test(label)) return SEMANTIC_ROLES.CONFIDENTIAL_DOC;
    return SEMANTIC_ROLES.PHYSICAL_CREDENTIAL;
  }

  // 3. Check OCR pattern text
  if (ocrData?.pattern) {
    switch (ocrData.pattern) {
      case "CREDIT_CARD": return SEMANTIC_ROLES.CREDIT_CARD_FIELD;
      case "EMAIL":       return SEMANTIC_ROLES.EMAIL_FIELD;
      case "PHONE":       return SEMANTIC_ROLES.PHONE_FIELD;
      case "SSN":
      case "AADHAAR":
      case "PAN":         return SEMANTIC_ROLES.GOV_ID_FIELD;
      default:            return SEMANTIC_ROLES.SENSITIVE_TEXT;
    }
  }

  // 4. Check DOM attributes, categories, and types
  if (domData) {
    const category = (domData.category || domData.piiCategory || "").toLowerCase();
    const type     = (domData.type || "").toLowerCase();
    const tag      = (domData.tagName || domData.tag || "").toLowerCase();
    const name     = [
      domData.name,
      domData.id,
      domData.placeholder,
      domData.label,
      domData.ariaLabel,
      domData.reason,
      domData.type,
      domData.selector,
    ].filter(Boolean).join(" ").toLowerCase();

    if (category === "passwords" || type === "password" || /password|pin|otp|current-password|new-password|pass/i.test(name)) {
      return SEMANTIC_ROLES.PASSWORD_FIELD;
    }
    if (type === "email" || /email|e-mail/i.test(name)) {
      return SEMANTIC_ROLES.EMAIL_FIELD;
    }
    if (category === "creditcards" || /credit|card.?num|cc-num|cvv|cvc|card.?exp/i.test(name)) {
      if (/cvv|cvc/i.test(name)) return SEMANTIC_ROLES.CVV_FIELD;
      if (/exp/i.test(name)) return SEMANTIC_ROLES.EXPIRY_FIELD;
      return SEMANTIC_ROLES.CREDIT_CARD_FIELD;
    }
    if (category === "govids" || /ssn|aadhar|aadhaar|passport|\bpan\b|gov.?id|tax.?id|kyc/i.test(name)) {
      return SEMANTIC_ROLES.GOV_ID_FIELD;
    }
    if (/phone|mobile|cell|tel/i.test(name)) {
      return SEMANTIC_ROLES.PHONE_FIELD;
    }
    if (/user.?name|login|uid/i.test(name)) {
      return SEMANTIC_ROLES.USERNAME_FIELD;
    }
    if (/\bname\b|full.?name|first.?name|last.?name/i.test(name)) {
      return SEMANTIC_ROLES.NAME_FIELD;
    }
    if (/address|street|city|postal|zip/i.test(name)) {
      return SEMANTIC_ROLES.ADDRESS_FIELD;
    }
    if (type === "file") {
      return SEMANTIC_ROLES.FILE_UPLOAD;
    }
    if (tag === "button" || type === "button" || type === "submit") {
      return SEMANTIC_ROLES.BUTTON;
    }
    if (tag === "a" || domData.role === "link") {
      return SEMANTIC_ROLES.LINK;
    }
    if (tag === "select") {
      return SEMANTIC_ROLES.SELECT;
    }
    if (type === "checkbox") return SEMANTIC_ROLES.CHECKBOX;
    if (type === "radio") return SEMANTIC_ROLES.RADIO;
    if (type === "search" || /search/i.test(name)) return SEMANTIC_ROLES.SEARCH_INPUT;
    if (tag === "input" || tag === "textarea") return SEMANTIC_ROLES.TEXT_INPUT;
  }

  return SEMANTIC_ROLES.GENERIC_INTERACTIVE;
}

/**
 * Builds a Unified Perception State from all perception channels.
 * 
 * @param {Object} params
 * @param {Array} params.domElements       - Interactive & labeled DOM elements
 * @param {Array} params.domSensitiveBoxes - DOM-scanned sensitive PII boxes
 * @param {Array} params.owlvitDetections  - OWL-ViT zero-shot detections
 * @param {Array} params.faceDetections    - MediaPipe face detections
 * @param {Array} params.ocrDetections     - Tesseract OCR detections
 * @param {Object} params.viewport         - { width, height, dpr, scrollX, scrollY }
 * @param {string} params.url              - Current tab URL
 * @returns {Object} UnifiedPerceptionState
 */
export function buildUnifiedPerceptionState({
  domElements       = [],
  domSensitiveBoxes = [],
  owlvitDetections  = [],
  faceDetections    = [],
  ocrDetections     = [],
  viewport          = { width: 1280, height: 800, dpr: 1 },
  url               = "",
}) {
  const dpr = viewport.dpr || 1;
  const unifiedElements = [];
  let elementCounter = 1;

  function nextId(prefix = "elem") {
    return `${prefix}_${String(elementCounter++).padStart(3, "0")}`;
  }

  // ── Step 1.1: Process DOM Interactive Elements ──────────────────────────────
  for (const dom of domElements) {
    const vx = dom.x ?? dom.left ?? 0;
    const vy = dom.y ?? dom.top ?? 0;
    const vw = dom.w ?? dom.width ?? 0;
    const vh = dom.h ?? dom.height ?? 0;

    // Screenshot canvas coordinates (physical pixels)
    const px = Math.round(vx * dpr);
    const py = Math.round(vy * dpr);
    const pw = Math.round(vw * dpr);
    const ph = Math.round(vh * dpr);

    const isSensitive = Boolean(dom.isSensitive || dom.sensitive);
    const piiCategory = dom.category || dom.piiCategory || (isSensitive ? "contactInfo" : "none");
    const role = determineSemanticRole(dom, null, null);

    unifiedElements.push({
      id: dom.id ? `dom_${dom.id}` : nextId("dom"),
      type: (dom.tagName || dom.tag || dom.type || "element").toLowerCase(),
      role: role,
      selector: dom.selector || dom.cssSelector || (dom.id ? `#${dom.id}` : ""),
      tag: (dom.tagName || dom.tag || "").toUpperCase(),
      text: dom.text || dom.innerText || dom.value || "",
      placeholder: dom.placeholder || "",
      label: dom.label || dom.ariaLabel || "",
      bbox: { x: px, y: py, w: pw, h: ph },
      viewportBbox: { x: vx, y: vy, w: vw, h: vh },
      isSensitive: isSensitive,
      piiCategory: piiCategory,
      sources: ["DOM"],
      confidence: 1.0,
      attributes: {
        name: dom.name || "",
        id: dom.id || "",
        type: dom.type || "",
        disabled: Boolean(dom.disabled),
        readOnly: Boolean(dom.readOnly),
        required: Boolean(dom.required),
      },
    });
  }

  // ── Step 1.2: Merge DOM Sensitive PII Scanner Boxes ─────────────────────────
  for (const box of domSensitiveBoxes) {
    const px = Math.round((box.x ?? 0) * dpr);
    const py = Math.round((box.y ?? 0) * dpr);
    const pw = Math.round((box.w ?? 0) * dpr);
    const ph = Math.round((box.h ?? 0) * dpr);
    const pBbox = { x: px, y: py, w: pw, h: ph };

    // Check if already matched to an existing DOM element
    let matched = unifiedElements.find((el) => computeIoU(el.bbox, pBbox) > 0.6);
    if (matched) {
      matched.isSensitive = true;
      matched.piiCategory = box.category || matched.piiCategory;
      matched.role = determineSemanticRole(box, null, null);
      if (!matched.sources.includes("DOM-PII-Scanner")) {
        matched.sources.push("DOM-PII-Scanner");
      }
    } else {
      unifiedElements.push({
        id: nextId("dom_pii"),
        type: box.type || "sensitive_input",
        role: determineSemanticRole(box, null, null),
        selector: box.selector || "",
        tag: (box.tagName || "INPUT").toUpperCase(),
        text: box.value || box.text || "",
        placeholder: box.placeholder || "",
        label: box.label || box.reason || "",
        bbox: pBbox,
        viewportBbox: { x: box.x, y: box.y, w: box.w, h: box.h },
        isSensitive: true,
        piiCategory: box.category || "contactInfo",
        sources: ["DOM-PII-Scanner"],
        confidence: 0.98,
        attributes: { reason: box.reason || "DOM classification" },
      });
    }
  }

  // ── Step 1.3: Merge MediaPipe Biometric Face Detections ──────────────────────
  for (const face of faceDetections) {
    const fBbox = { x: face.x, y: face.y, w: face.w, h: face.h };
    const vx = Math.round(face.x / dpr);
    const vy = Math.round(face.y / dpr);
    const vw = Math.round(face.w / dpr);
    const vh = Math.round(face.h / dpr);

    unifiedElements.push({
      id: nextId("face"),
      type: "biometric",
      role: SEMANTIC_ROLES.BIOMETRIC_FACE,
      selector: "",
      tag: "FACE",
      text: "[Biometric Face]",
      placeholder: "",
      label: "Face",
      bbox: fBbox,
      viewportBbox: { x: vx, y: vy, w: vw, h: vh },
      isSensitive: true,
      piiCategory: "faces",
      sources: ["MediaPipe-Face"],
      confidence: face.confidence ?? 0.92,
      attributes: { biometricType: "face" },
    });
  }

  // ── Step 1.4: Merge OWL-ViT Zero-Shot Visual Object Detections ───────────────
  for (const det of owlvitDetections) {
    const oBbox = { x: det.x, y: det.y, w: det.w, h: det.h };
    const vx = Math.round(det.x / dpr);
    const vy = Math.round(det.y / dpr);
    const vw = Math.round(det.w / dpr);
    const vh = Math.round(det.h / dpr);

    // If it's a face detected by person slice and MediaPipe already caught it, fuse
    const existingFace = unifiedElements.find(
      (el) => el.role === SEMANTIC_ROLES.BIOMETRIC_FACE && computeIoU(el.bbox, oBbox) > 0.4
    );

    if (existingFace) {
      if (!existingFace.sources.includes("OWL-ViT")) existingFace.sources.push("OWL-ViT");
      existingFace.confidence = Math.max(existingFace.confidence, det.confidence || 0.85);
      continue;
    }

    const role = determineSemanticRole(null, null, det);
    unifiedElements.push({
      id: nextId("vis"),
      type: "visual_object",
      role: role,
      selector: "",
      tag: "OBJECT",
      text: `[Visual: ${det.label}]`,
      placeholder: "",
      label: det.label || "Object",
      bbox: oBbox,
      viewportBbox: { x: vx, y: vy, w: vw, h: vh },
      isSensitive: true,
      piiCategory: det.category || "govIds",
      sources: ["OWL-ViT"],
      confidence: det.confidence || det.score || 0.85,
      attributes: { visualLabel: det.label },
    });
  }

  // ── Step 1.5: Merge Tesseract OCR Visual Text Detections ────────────────────
  for (const ocr of ocrDetections) {
    const ocrBbox = { x: ocr.x, y: ocr.y, w: ocr.w, h: ocr.h };
    const vx = Math.round(ocr.x / dpr);
    const vy = Math.round(ocr.y / dpr);
    const vw = Math.round(ocr.w / dpr);
    const vh = Math.round(ocr.h / dpr);

    // Check if OCR falls inside or overlaps an existing element
    let matched = unifiedElements.find((el) => computeContainment(ocrBbox, el.bbox) > 0.5 || computeIoU(el.bbox, ocrBbox) > 0.4);

    if (matched) {
      if (!matched.sources.includes("Tesseract-OCR")) matched.sources.push("Tesseract-OCR");
      matched.text = matched.text || ocr.text;
      if (ocr.pattern) {
        matched.isSensitive = true;
        matched.piiCategory = ocr.category || matched.piiCategory;
        matched.role = determineSemanticRole(null, ocr, null);
      }
    } else {
      const role = determineSemanticRole(null, ocr, null);
      unifiedElements.push({
        id: nextId("ocr"),
        type: "text_node",
        role: role,
        selector: "",
        tag: "TEXT",
        text: ocr.text || "",
        placeholder: "",
        label: ocr.pattern || "OCR Text",
        bbox: ocrBbox,
        viewportBbox: { x: vx, y: vy, w: vw, h: vh },
        isSensitive: Boolean(ocr.pattern),
        piiCategory: ocr.category || (ocr.pattern ? "contactInfo" : "none"),
        sources: ["Tesseract-OCR"],
        confidence: 0.90,
        attributes: { ocrPattern: ocr.pattern || null },
      });
    }
  }

  // ── Step 1.6: Summary Statistics ────────────────────────────────────────────
  const categories = {};
  const sources = {};
  let sensitiveCount = 0;

  for (const el of unifiedElements) {
    if (el.isSensitive) {
      sensitiveCount++;
      categories[el.piiCategory] = (categories[el.piiCategory] || 0) + 1;
    }
    for (const src of el.sources) {
      sources[src] = (sources[src] || 0) + 1;
    }
  }

  return {
    timestamp: Date.now(),
    url: url,
    viewport: viewport,
    elements: unifiedElements,
    summary: {
      totalElements: unifiedElements.length,
      sensitiveCount: sensitiveCount,
      categories: categories,
      sources: sources,
    },
  };
}
