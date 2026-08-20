/**
 * Mutates the parts of a .docx zip that raw-XML injection depends on:
 * relationships (images, hyperlinks), media files, content types and list
 * numbering definitions.
 *
 * Usage:
 *   const parts = new DocxAssembler(zip);
 *   parts.load();
 *   const rId = parts.addImage(buffer, 'png');
 *   const { bulletNumId } = parts.ensureNumbering();
 *   // ...render with docxtemplater...
 *   parts.commit();
 *
 * Relationship ids must be allocated *before* rendering (the injected XML
 * embeds them) but the files themselves are written afterwards, which is why
 * allocation and commit are separate steps.
 */

const DOC_RELS = 'word/_rels/document.xml.rels';
/**
 * The *package* relationships, which is a different file from the document's own.
 *
 * Custom document properties hang off the package rather than off `word/document.xml`, which is why
 * this exists alongside DOC_RELS. Getting the two the wrong way round produces a file Word opens
 * and silently shows no properties for — no error, no clue.
 */
const PACKAGE_RELS = '_rels/.rels';
const CUSTOM_PROPS = 'docProps/custom.xml';
const CUSTOM_PROPS_TYPE =
  'application/vnd.openxmlformats-officedocument.custom-properties+xml';
const CUSTOM_PROPS_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';
const CONTENT_TYPES = '[Content_Types].xml';
const NUMBERING = 'word/numbering.xml';
const SETTINGS = 'word/settings.xml';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/**
 * Elements that come *after* `w:updateFields` in the settings schema.
 *
 * `w:settings` is a sequence, not a bag: an element in the wrong place makes Word offer to
 * repair the file. Rather than reproduce the whole sixty-element order, this is the tail — the
 * new element goes before the first of these that the template happens to have, and at the end
 * if it has none of them.
 */
const AFTER_UPDATE_FIELDS = [
  '<w:hdrShapeDefaults',
  '<w:footnotePr',
  '<w:endnotePr',
  '<w:compat',
  '<w:docVars',
  '<w:rsids',
  '<m:mathPr',
  '<w:attachedSchema',
  '<w:themeFontLang',
  '<w:clrSchemeMapping',
  '<w:doNotIncludeSubdocsInStats',
  '<w:doNotAutoCompressPictures',
  '<w:forceUpgrade',
  '<w:captions',
  '<w:readModeInkLockDown',
  '<w:smartTagType',
  '<sl:schemaLibrary',
  '<w:shapeDefaults',
  '<w:doNotEmbedSmartTags',
  '<w:decimalSymbol',
  '<w:listSeparator',
  '<w15:chartTrackingRefBased',
  '<w15:docId',
];

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = {
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
};

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
};

const xmlAttr = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export class DocxAssembler {
  constructor(zip) {
    this.zip = zip;
    this.relsXml = '';
    this.contentTypesXml = '';
    this.nextRelId = 1;
    /** @type {Array<{id:string,type:string,target:string,mode?:string}>} */
    this.newRels = [];
    /** @type {Array<{path:string,buffer:Buffer}>} */
    this.newFiles = [];
    this.newExtensions = new Set();
    /** Whether the document should ask Word to refresh its fields when it opens. */
    this.updateFieldsOnOpen = false;
    this.hyperlinkCache = new Map();
    this.numbering = null;
    /** The provenance part to write on commit, or null for a render that carries none. */
    this.customPropsXml = null;
    /**
     * `word/numbering.xml` as it will be written, plus the extra `<w:num>` instances
     * allocated during rendering.
     *
     * Held here rather than queued straight into the zip because `newOrderedList()` is
     * called *while* the document renders — after `ensureNumbering()` has run — and every
     * instance it hands out has to end up in the same part.
     */
    this.numberingXml = null;
    this.extraNums = [];
    this.imageCount = 0;
    this.docPrId = 1000;
    /** @type {Set<string>} style ids declared by word/styles.xml */
    this.styleIds = new Set();
    /** The template's own page geometry; Letter portrait with 1" margins until `load()`. */
    this.page = { ...LETTER };
  }

  #read(path) {
    const file = this.zip.file(path);
    return file ? file.asText() : null;
  }

  load() {
    this.relsXml = this.#read(DOC_RELS) ?? '';
    this.contentTypesXml = this.#read(CONTENT_TYPES) ?? '';
    /*
     * Exactly what the template had, kept so `commit()` can tell whether *anything* changed the
     * content types — see the note where it decides whether to write the part back.
     */
    this.#loadedContentTypesXml = this.contentTypesXml;
    this.#loadedRelsXml = this.relsXml;
    let max = 0;
    for (const match of this.relsXml.matchAll(/Id="rId(\d+)"/g)) {
      max = Math.max(max, Number(match[1]));
    }
    // Leave a gap so ids can never collide with anything docxtemplater emits.
    this.nextRelId = max + 100;

    // Which styles the template actually defines. Word silently renders an
    // unknown pStyle as Normal, so knowing this lets rich text fall back to
    // direct formatting instead of quietly losing its headings and quotes.
    this.styleIds = new Set();
    const styles = this.#read('word/styles.xml') ?? '';
    for (const match of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"/g)) {
      this.styleIds.add(match[1]);
    }

    this.page = readPageGeometry(this.#read('word/document.xml') ?? '');
    return this;
  }

  /**
   * How wide the text column actually is, in twentieths of a point.
   *
   * Everything this app draws at a fixed width — tables, code panes, images — has to be
   * measured against the template's own page, not against the US Letter assumption that was
   * hardcoded in three places. An A4 template with 2.5 cm margins has a 9070-twip column,
   * not 9360, and a landscape section has half again as much.
   */
  get usableTwips() {
    return this.page?.usableTwips ?? LETTER.usableTwips;
  }

  hasStyle(id) {
    return this.styleIds?.has(id) ?? false;
  }

  #allocRelId() {
    const id = `rId${this.nextRelId}`;
    this.nextRelId += 1;
    return id;
  }

  /** Registers an image and returns the relationship id plus a unique drawing id. */
  addImage(buffer, ext = 'png') {
    const extension = (MIME_BY_EXT[ext.toLowerCase()] ? ext.toLowerCase() : 'png');
    this.imageCount += 1;
    const name = `engy-media-${this.imageCount}.${extension}`;
    const id = this.#allocRelId();
    this.newFiles.push({ path: `word/media/${name}`, buffer });
    this.newRels.push({ id, type: REL_TYPE.image, target: `media/${name}` });
    this.newExtensions.add(extension);
    this.docPrId += 1;
    return { rId: id, docPrId: this.docPrId, name };
  }

  addHyperlink(url) {
    if (this.hyperlinkCache.has(url)) return this.hyperlinkCache.get(url);
    const id = this.#allocRelId();
    this.newRels.push({ id, type: REL_TYPE.hyperlink, target: url, mode: 'External' });
    this.hyperlinkCache.set(url, id);
    return id;
  }

  /**
   * Guarantees the document has a bullet and an ordered numbering definition,
   * returning their numIds. Existing definitions are left untouched.
   */
  ensureNumbering() {
    if (this.numbering) return this.numbering;

    const existing = this.#read(NUMBERING);
    if (existing === null) {
      const bulletNumId = 1;
      const orderedNumId = 2;
      const xml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        abstractNumXml(1, 'bullet') +
        abstractNumXml(2, 'ordered') +
        `<w:num w:numId="${bulletNumId}"><w:abstractNumId w:val="1"/></w:num>` +
        `<w:num w:numId="${orderedNumId}"><w:abstractNumId w:val="2"/></w:num>` +
        '</w:numbering>';
      // Written at commit(), so ordered lists allocated mid-render land in the same part.
      this.numberingXml = xml;
      this.newRels.push({ id: this.#allocRelId(), type: REL_TYPE.numbering, target: 'numbering.xml' });
      this.#needsNumberingContentType = true;
      this.numbering = { bulletNumId, orderedNumId, orderedAbstract: 2, nextNumId: orderedNumId + 1 };
      return this.numbering;
    }

    let maxAbstract = -1;
    for (const m of existing.matchAll(/w:abstractNumId w:val="(\d+)"/g)) {
      maxAbstract = Math.max(maxAbstract, Number(m[1]));
    }
    for (const m of existing.matchAll(/<w:abstractNum[^>]*w:abstractNumId="(\d+)"/g)) {
      maxAbstract = Math.max(maxAbstract, Number(m[1]));
    }
    let maxNum = 0;
    for (const m of existing.matchAll(/<w:num[ >][^>]*w:numId="(\d+)"/g)) {
      maxNum = Math.max(maxNum, Number(m[1]));
    }

    const bulletAbstract = maxAbstract + 1;
    const orderedAbstract = maxAbstract + 2;
    const bulletNumId = maxNum + 1;
    const orderedNumId = maxNum + 2;

    const abstractBlock = abstractNumXml(bulletAbstract, 'bullet') + abstractNumXml(orderedAbstract, 'ordered');
    const numBlock =
      `<w:num w:numId="${bulletNumId}"><w:abstractNumId w:val="${bulletAbstract}"/></w:num>` +
      `<w:num w:numId="${orderedNumId}"><w:abstractNumId w:val="${orderedAbstract}"/></w:num>`;

    // Schema order inside <w:numbering>: numPicBullet*, abstractNum*, num*.
    let updated = existing;
    const firstNum = updated.search(/<w:num[ >]/);
    if (firstNum !== -1) {
      updated = updated.slice(0, firstNum) + abstractBlock + updated.slice(firstNum);
    } else {
      updated = updated.replace('</w:numbering>', `${abstractBlock}</w:numbering>`);
    }
    updated = updated.replace('</w:numbering>', `${numBlock}</w:numbering>`);

    this.numberingXml = updated;
    this.numbering = {
      bulletNumId,
      orderedNumId,
      orderedAbstract,
      nextNumId: orderedNumId + 1,
    };
    return this.numbering;
  }

  /**
   * A numbering instance for one ordered list, restarting at 1.
   *
   * The bug this exists for: every `<ol>` in the document shared a single `w:num`, and a
   * numbering instance counts continuously — so the second numbered list in a report carried
   * on from the first, and finding 3's remediation steps began at 4. A list restarts only if
   * it is its own instance with an explicit `startOverride`, which is what this allocates.
   *
   * All nine levels are overridden, not just the first: a sub-list that has been used earlier
   * in another instance would otherwise resume its own count.
   */
  newOrderedList() {
    const base = this.ensureNumbering();
    // Nothing to point at (a template we could not parse): reuse the shared instance rather
    // than emitting a reference to a definition that does not exist.
    if (!this.numberingXml) return base.orderedNumId;

    const numId = base.nextNumId;
    base.nextNumId += 1;
    const overrides = Array.from(
      { length: 9 },
      (_unused, level) =>
        `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="1"/></w:lvlOverride>`
    ).join('');
    this.extraNums.push(
      `<w:num w:numId="${numId}"><w:abstractNumId w:val="${base.orderedAbstract}"/>${overrides}</w:num>`
    );
    return numId;
  }

  #needsNumberingContentType = false;
  /** `[Content_Types].xml` as the template had it, for the changed-at-all test in `commit()`. */
  #loadedContentTypesXml = '';
  /** And the document's relationships, for the same test and the same reason. */
  #loadedRelsXml = '';
  /** Set when the template had no settings part and one was created for it. */
  #needsSettingsPart = false;

  /** Writes every queued file plus the updated rels/content-types into the zip. */
  /**
   * Asks Word to refresh every field when the document is opened.
   *
   * A table of contents is a field: until something updates it, the reader sees "Right-click to
   * update field" where the contents should be, and that is the first page of the document. The
   * cross-reference and page-reference fields a template can now produce have the same problem —
   * they show whatever was written into them at generation time until they are refreshed.
   *
   * One element in `word/settings.xml` fixes all of it, and Word applies it silently on open.
   * Deliberately opt-out-able: a firm that wants the numbers frozen exactly as generated has a
   * reason, and this is the switch for it.
   */
  /**
   * Stamps the document with where it came from.
   *
   * Written as custom document properties, so the file describes itself to anybody holding it —
   * Word shows them under File → Info → Properties → Advanced. Any custom properties the template
   * already carried are replaced rather than merged: a template's own are part of the template, and
   * a document that claimed two render ids would be worse than one that claims the right one.
   *
   * Queued rather than written, because `commit()` is the one place this class touches the zip.
   */
  setCustomProperties(xml) {
    this.customPropsXml = xml || null;
    return this;
  }

  /** Adds the part, its content type and the package relationship that makes Word read it. */
  #commitCustomProperties() {
    if (!this.customPropsXml) return;
    this.zip.file(CUSTOM_PROPS, Buffer.from(this.customPropsXml, 'utf8'));

    const rels = this.#read(PACKAGE_RELS) ?? '';
    if (rels && !rels.includes(CUSTOM_PROPS)) {
      /*
       * A relationship id of its own, and not one from the document's sequence: these two files
       * number independently, and reusing an id from the wrong one is how a package ends up with
       * two rId1s and Word calls it unreadable.
       */
      let max = 0;
      for (const match of rels.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(match[1]));
      const id = `rId${max + 1}`;
      const updated = rels.replace(
        '</Relationships>',
        `<Relationship Id="${id}" Type="${CUSTOM_PROPS_REL}" Target="docProps/custom.xml"/></Relationships>`
      );
      this.zip.file(PACKAGE_RELS, Buffer.from(updated, 'utf8'));
    }

    if (this.contentTypesXml && !this.contentTypesXml.includes(CUSTOM_PROPS)) {
      this.contentTypesXml = this.contentTypesXml.replace(
        '</Types>',
        `<Override PartName="/docProps/custom.xml" ContentType="${CUSTOM_PROPS_TYPE}"/></Types>`
      );
    }
  }

  requestFieldUpdate(enabled = true) {
    this.updateFieldsOnOpen = Boolean(enabled);
  }

  /**
   * Writes `<w:updateFields w:val="true"/>` into the settings part, creating it if the template
   * has none — an unusual template, but one Word accepts, and the part has to exist and be
   * declared before anything can be put in it.
   */
  #commitSettings() {
    if (!this.updateFieldsOnOpen) return;

    const existing = this.zip.file(SETTINGS);
    if (!existing) {
      this.zip.file(
        SETTINGS,
        Buffer.from(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            `<w:settings xmlns:w="${W_NS}"><w:updateFields w:val="true"/></w:settings>`,
          'utf8'
        )
      );
      this.#needsSettingsPart = true;
      return;
    }

    let xml = existing.asText();

    // Already asked for: make sure it says true rather than adding a second one.
    if (/<w:updateFields\b/.test(xml)) {
      xml = xml.replace(/<w:updateFields\b[^>]*\/>/, '<w:updateFields w:val="true"/>');
      xml = xml.replace(
        /<w:updateFields\b[^>]*>[\s\S]*?<\/w:updateFields>/,
        '<w:updateFields w:val="true"/>'
      );
      this.zip.file(SETTINGS, Buffer.from(xml, 'utf8'));
      return;
    }

    const element = '<w:updateFields w:val="true"/>';
    let inserted = false;
    for (const marker of AFTER_UPDATE_FIELDS) {
      const at = xml.indexOf(marker);
      if (at === -1) continue;
      xml = xml.slice(0, at) + element + xml.slice(at);
      inserted = true;
      break;
    }
    if (!inserted) {
      if (xml.includes('</w:settings>')) {
        xml = xml.replace('</w:settings>', `${element}</w:settings>`);
      } else {
        // A self-closing `<w:settings .../>`: an empty settings part, which is still legal.
        xml = xml.replace(/<w:settings([^>]*)\/>/, `<w:settings$1>${element}</w:settings>`);
      }
    }
    this.zip.file(SETTINGS, Buffer.from(xml, 'utf8'));
  }

  commit() {
    if (this.numberingXml) {
      // `<w:num>` elements come last inside `<w:numbering>`, so appending is schema-correct.
      const xml = this.extraNums.length
        ? this.numberingXml.replace('</w:numbering>', `${this.extraNums.join('')}</w:numbering>`)
        : this.numberingXml;
      this.zip.file(NUMBERING, Buffer.from(xml, 'utf8'));
    }

    for (const { path, buffer } of this.newFiles) {
      this.zip.file(path, buffer);
    }

    /*
     * The relationships, written whenever they differ from what the template had.
     *
     * The guard used to be `newRels.length` — correct today, because queuing a relationship is the
     * only way this class changes them. It is also the shape that shipped a corrupt document: a
     * later step that edits `relsXml` directly, the way the provenance step edits the content types,
     * would compute a change nothing ever wrote. Comparing against what was loaded costs a string
     * comparison and removes the whole category.
     */
    if (this.relsXml) {
      const additions = this.newRels
        .map(
          (r) =>
            `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlAttr(r.target)}"` +
            `${r.mode ? ` TargetMode="${r.mode}"` : ''}/>`
        )
        .join('');
      const updated = !additions
        ? this.relsXml
        : this.relsXml.includes('</Relationships>')
          ? this.relsXml.replace('</Relationships>', `${additions}</Relationships>`)
          : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${additions}</Relationships>`;
      if (updated !== this.#loadedRelsXml) this.zip.file(DOC_RELS, Buffer.from(updated, 'utf8'));
    }

    this.#commitSettings();
    /*
     * Before the content types are written, because it adds an override to them. The ordering here
     * is load-bearing: a part with no content type is a part Word refuses to open the file over.
     */
    this.#commitCustomProperties();

    if (this.contentTypesXml) {
      let ct = this.contentTypesXml;
      for (const ext of this.newExtensions) {
        if (new RegExp(`Extension="${ext}"`, 'i').test(ct)) continue;
        ct = ct.replace(
          '</Types>',
          `<Default Extension="${ext}" ContentType="${MIME_BY_EXT[ext]}"/></Types>`
        );
      }
      if (this.#needsNumberingContentType && !ct.includes('/word/numbering.xml')) {
        ct = ct.replace(
          '</Types>',
          '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'
        );
      }
      if (this.#needsSettingsPart && !ct.includes('/word/settings.xml')) {
        ct = ct.replace(
          '</Types>',
          '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'
        );
      }
      /*
       * Written whenever it differs from what the template had — not from `this.contentTypesXml`.
       *
       * That comparison was the bug: `#commitCustomProperties()` above updates `contentTypesXml`
       * in place, so comparing against it asked "did the *loop just above* change anything", and
       * the answer is no on any report that adds no new image extension. The provenance override
       * was then dropped, leaving a `docProps/custom.xml` in the package with no content type —
       * which Word refuses to open at all, with a message about permissions and disk space.
       *
       * It survived every test because the templates in play already declared that override, and
       * the one report that did open happened to contain a .jpg, which forced the write.
       */
      if (ct !== this.#loadedContentTypesXml) this.zip.file(CONTENT_TYPES, Buffer.from(ct, 'utf8'));
    }

    return this.zip;
  }
}

/* -------------------------------------------------------------------------- */
/* Page geometry                                                              */
/* -------------------------------------------------------------------------- */

/** US Letter, portrait, 1" margins — Word's own default, and the historical assumption. */
const LETTER = {
  widthTwips: 12240,
  heightTwips: 15840,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  landscape: false,
  usableTwips: 9360,
};

/**
 * The page the body of this template actually uses.
 *
 * The body-level `<w:sectPr>` is the last one in the document: any earlier ones belong to
 * section breaks inside the text, and it is the final section — the one everything generated
 * lands in — whose geometry matters here.
 *
 * A template that cannot be parsed falls back to Letter, which is what every measurement in
 * this app assumed before, so an unreadable sectPr changes nothing rather than producing a
 * document with tables of a made-up width.
 */
export function readPageGeometry(documentXml) {
  const sections = [...String(documentXml ?? '').matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)];
  const section = sections.length ? sections[sections.length - 1][0] : '';
  if (!section) return { ...LETTER };

  const number = (source, attr) => {
    const match = new RegExp(`w:${attr}="(-?\\d+)"`).exec(source ?? '');
    return match ? Number(match[1]) : null;
  };

  const pgSz = /<w:pgSz\b[^>]*\/?>/.exec(section)?.[0] ?? '';
  const pgMar = /<w:pgMar\b[^>]*\/?>/.exec(section)?.[0] ?? '';

  const widthTwips = number(pgSz, 'w') ?? LETTER.widthTwips;
  const heightTwips = number(pgSz, 'h') ?? LETTER.heightTwips;
  const marginLeft = number(pgMar, 'left') ?? LETTER.marginLeft;
  const marginRight = number(pgMar, 'right') ?? LETTER.marginRight;
  const gutter = number(pgMar, 'gutter') ?? 0;
  // Word writes the *rotated* page size for a landscape section, so the width needs no
  // adjusting — the orientation is read only so callers can say what they are looking at.
  const landscape = /w:orient="landscape"/.test(pgSz);

  const usable = widthTwips - marginLeft - marginRight - gutter;
  return {
    widthTwips,
    heightTwips,
    marginLeft,
    marginRight,
    gutter,
    landscape,
    /*
     * A floor rather than trusting the arithmetic: a template with a mis-set margin can
     * describe a negative column, and a table 0 twips wide is a worse document than one
     * sized for a narrow page.
     */
    usableTwips: usable > 1440 ? usable : LETTER.usableTwips,
  };
}

/* -------------------------------------------------------------------------- */
/* Numbering definitions                                                      */
/* -------------------------------------------------------------------------- */

const BULLET_LEVELS = [
  { char: '', font: 'Symbol' },
  { char: 'o', font: 'Courier New' },
  { char: '', font: 'Wingdings' },
];
const ORDERED_LEVELS = [
  { fmt: 'decimal', text: '%LVL.' },
  { fmt: 'lowerLetter', text: '%LVL.' },
  { fmt: 'lowerRoman', text: '%LVL.' },
];

function abstractNumXml(abstractId, kind) {
  const levels = [];
  for (let lvl = 0; lvl < 9; lvl += 1) {
    const indentLeft = 720 * (lvl + 1);
    if (kind === 'bullet') {
      const spec = BULLET_LEVELS[lvl % BULLET_LEVELS.length];
      levels.push(
        `<w:lvl w:ilvl="${lvl}">` +
          '<w:start w:val="1"/>' +
          '<w:numFmt w:val="bullet"/>' +
          '<w:lvlText w:val="' + xmlAttr(spec.char) + '"/>' +
          '<w:lvlJc w:val="left"/>' +
          `<w:pPr><w:ind w:left="${indentLeft}" w:hanging="360"/></w:pPr>` +
          `<w:rPr><w:rFonts w:ascii="${spec.font}" w:hAnsi="${spec.font}" w:hint="default"/></w:rPr>` +
          '</w:lvl>'
      );
    } else {
      const spec = ORDERED_LEVELS[lvl % ORDERED_LEVELS.length];
      levels.push(
        `<w:lvl w:ilvl="${lvl}">` +
          '<w:start w:val="1"/>' +
          `<w:numFmt w:val="${spec.fmt}"/>` +
          `<w:lvlText w:val="${spec.text.replace('%LVL', `%${lvl + 1}`)}"/>` +
          '<w:lvlJc w:val="left"/>' +
          `<w:pPr><w:ind w:left="${indentLeft}" w:hanging="360"/></w:pPr>` +
          '</w:lvl>'
      );
    }
  }
  return (
    `<w:abstractNum w:abstractNumId="${abstractId}">` +
    `<w:multiLevelType w:val="${kind === 'bullet' ? 'hybridMultilevel' : 'multilevel'}"/>` +
    levels.join('') +
    '</w:abstractNum>'
  );
}

export default DocxAssembler;
