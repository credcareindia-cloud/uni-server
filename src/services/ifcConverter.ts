import * as FRAGS from '@thatopen/fragments';
import { logger } from '../utils/logger.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

type StoreyElementRow = { id: string; name: string; type: string; material: string };

/**
 * When IFC lists both a Structural Framing Assembly and a Structural Connections Assembly
 * for the same panel tag (e.g. *ILB-101:…), keep only the Framing row for DB / panel management.
 */
export function dedupeIfcStoreyElementsPreferFraming(elements: StoreyElementRow[]): StoreyElementRow[] {
  const isAssembly = (t: string) => (t || '').toUpperCase().includes('ELEMENTASSEMBLY');

  const tagKey = (name: string): string | null => {
    const n = name || '';
    const star = n.match(/\*([A-Z][A-Z0-9]*-\d+)/i);
    if (star) return star[1].toUpperCase();
    const w = n.match(/\b([A-Z][A-Z0-9]{1,12}-\d{2,10})\b/);
    return w ? w[1].toUpperCase() : null;
  };

  const framingScore = (name: string): number => {
    const low = (name || '').toLowerCase();
    if (low.includes('framing')) return 2;
    if (low.includes('connection') || low.includes('connections')) return 0;
    return 1;
  };

  const byKey = new Map<string, number[]>();
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (!isAssembly(e.type)) continue;
    const key = tagKey(e.name);
    if (!key) continue;
    const arr = byKey.get(key) || [];
    arr.push(i);
    byKey.set(key, arr);
  }

  const drop = new Set<number>();
  for (const indices of byKey.values()) {
    if (indices.length < 2) continue;
    let best = indices[0];
    let bestScore = framingScore(elements[best].name);
    for (let k = 1; k < indices.length; k++) {
      const idx = indices[k];
      const sc = framingScore(elements[idx].name);
      if (sc > bestScore) {
        bestScore = sc;
        best = idx;
      }
    }
    for (const idx of indices) {
      if (idx !== best) drop.add(idx);
    }
  }

  if (!drop.size) return elements;
  return elements.filter((_, i) => !drop.has(i));
}

/**
 * IFC to Fragments Converter Service
 * Converts IFC files to optimized .frag format and extracts metadata
 */
export class IfcConverterService {
  private serializer: FRAGS.IfcImporter | null = null;
  private isInitialized: boolean = false;

  constructor() {
    logger.info('✅ IFC Converter Service created (WASM will load on first use)');
  }

  /**
   * Lazy initialization - only load WASM when actually needed
   */
  private resolveWasmPath(): string {
    // web-ifc automatically looks in its own directory if path is empty/relative
    // The previous absolute path approach caused double concatenation
    return '';
  }

  /**
   * Lazy initialization - only load WASM when actually needed
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized && this.serializer) {
      return; // Already initialized
    }

    logger.info('🔄 Initializing IFC Converter with WASM...');

    // Initialize IFC serializer with web-ifc WASM
    this.serializer = new FRAGS.IfcImporter();

    // Robust WASM path resolution
    const wasmPath = this.resolveWasmPath();
    this.serializer.wasm = {
      absolute: false,
      path: wasmPath
    };

    this.isInitialized = true;
    logger.info('✅ IFC Converter initialized');
    logger.info(`📦 WASM path: ${wasmPath || '(default)'}`);
  }

  /**
   * Extract metadata from IFC file BEFORE conversion
   * @param ifcBuffer - IFC file buffer
   * @returns Extracted IFC metadata
   */
  async extractIfcMetadata(ifcBuffer: Buffer): Promise<{
    totalElements: number;
    storeys: Array<{ name: string; elementCount: number; elements: Array<{ id: string; name: string; type: string; material: string }> }>;
    elementTypes: Record<string, number>;
    spatialStructure: any;
  }> {
    try {
      logger.info(`📊 Extracting metadata from IFC file (${ifcBuffer.length} bytes)...`);

      const WebIFC = await import('web-ifc');
      const ifcApi = new WebIFC.IfcAPI();

      // Initialize WASM
      ifcApi.SetWasmPath(this.resolveWasmPath());
      await ifcApi.Init();

      // Load IFC file
      const ifcBytes = new Uint8Array(ifcBuffer);
      const modelID = ifcApi.OpenModel(ifcBytes);

      logger.info(`✅ IFC file loaded, model ID: ${modelID}`);

      // Extract spatial structure
      const storeys: Array<{ name: string; elementCount: number; elements: Array<{ id: string; name: string; type: string; material: string }> }> = [];
      const elementTypes: Record<string, number> = {};
      let totalElements = 0;

      // Common IFC element types to count
      const elementTypeIds = [
        // Structural elements
        WebIFC.IFCWALL,
        WebIFC.IFCWALLSTANDARDCASE,
        WebIFC.IFCSLAB,
        WebIFC.IFCBEAM,
        WebIFC.IFCCOLUMN,
        WebIFC.IFCMEMBER, // Structural members / frames
        WebIFC.IFCPLATE,
        WebIFC.IFCFOOTING,
        WebIFC.IFCPILE,

        // Doors and windows
        WebIFC.IFCDOOR,
        WebIFC.IFCWINDOW,

        // Building elements
        WebIFC.IFCROOF,
        WebIFC.IFCSTAIR,
        WebIFC.IFCRAILING,
        WebIFC.IFCCURTAINWALL,
        WebIFC.IFCRAMP,
        WebIFC.IFCSPACE,
        WebIFC.IFCFURNISHINGELEMENT,

        // MEP - Distribution elements
        WebIFC.IFCDUCTFITTING,
        WebIFC.IFCDUCTSEGMENT,
        WebIFC.IFCPIPEFITTING,
        WebIFC.IFCPIPESEGMENT,
        WebIFC.IFCFLOWSEGMENT,

        // MEP - Flow control and terminals
        WebIFC.IFCFLOWCONTROLLER,
        WebIFC.IFCFLOWTERMINAL,
        WebIFC.IFCVALVE,
        WebIFC.IFCDAMPER,
        WebIFC.IFCAIRTERMINAL,

        // MEP - Electrical elements
        WebIFC.IFCCABLECARRIERFITTING,
        WebIFC.IFCCABLECARRIERSEGMENT,
        WebIFC.IFCCABLESEGMENT,
        WebIFC.IFCELECTRICALELEMENT,
        WebIFC.IFCELECTRICDISTRIBUTIONBOARD,
        WebIFC.IFCLIGHTFIXTURE,

        // MEP - HVAC equipment
        WebIFC.IFCFAN,
        WebIFC.IFCPUMP,
        WebIFC.IFCBOILER,
        WebIFC.IFCCHILLER,
        WebIFC.IFCCOIL,
        WebIFC.IFCHEATEXCHANGER
      ];

      // Count all elements by type
      for (const typeId of elementTypeIds) {
        try {
          const elements = ifcApi.GetLineIDsWithType(modelID, typeId);
          const count = elements.size();
          if (count > 0) {
            const typeName = ifcApi.GetNameFromTypeCode(typeId);
            elementTypes[typeName] = count;
            totalElements += count;
            logger.info(`📦 Found ${count} ${typeName} elements`);
          }
        } catch (err) {
          // Skip if type not found
        }
      }

      // Get all building storeys
      const storeyIds = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
      logger.info(`📦 Found ${storeyIds.size()} storeys`);

      for (let i = 0; i < storeyIds.size(); i++) {
        const storeyId = storeyIds.get(i);
        const storey = ifcApi.GetLine(modelID, storeyId);
        const storeyName = storey.Name?.value || storey.LongName?.value || `Storey ${i + 1}`;

        // Get elements in this storey using spatial containment
        let elementCount = 0;
        const storeyElements: Array<{ id: string; name: string; type: string; material: string }> = [];

        try {
          const relContained = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
          for (let j = 0; j < relContained.size(); j++) {
            const relId = relContained.get(j);
            const rel = ifcApi.GetLine(modelID, relId);
            if (rel.RelatingStructure?.value === storeyId && rel.RelatedElements) {
              elementCount = rel.RelatedElements.length;

              // Extract individual elements (panels)
              for (const elementRef of rel.RelatedElements) {
                try {
                  const elementId = elementRef.value;
                  const element = ifcApi.GetLine(modelID, elementId);
                  const elementType = ifcApi.GetNameFromTypeCode(element.type);
                  const rawName = element.Name?.value != null ? String(element.Name.value) : '';
                  const rawTag = element.Tag?.value != null ? String(element.Tag.value) : '';
                  const elementName = rawName || rawTag || `${elementType}-${elementId}`;

                  // Extract material information
                  let material = 'N/A';
                  try {
                    // Try to get material from IfcRelAssociatesMaterial
                    const relMaterials = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCRELASSOCIATESMATERIAL);
                    for (let m = 0; m < relMaterials.size(); m++) {
                      const relMatId = relMaterials.get(m);
                      const relMat = ifcApi.GetLine(modelID, relMatId);
                      if (relMat.RelatedObjects) {
                        const relatedObjs = relMat.RelatedObjects;
                        for (const obj of relatedObjs) {
                          if (obj.value === elementId && relMat.RelatingMaterial) {
                            const matId = relMat.RelatingMaterial.value;
                            const matObj = ifcApi.GetLine(modelID, matId);
                            material = matObj.Name?.value || 'Unknown Material';
                            break;
                          }
                        }
                      }
                      if (material !== 'N/A') break;
                    }
                  } catch (matErr) {
                    // Material extraction failed, keep N/A
                  }

                  storeyElements.push({
                    id: `${elementId}`,
                    name: elementName,
                    type: elementType,
                    material: material
                  });
                } catch (err) {
                  // Skip invalid elements
                }
              }
              break;
            }
          }
        } catch (err) {
          logger.warn(`⚠️  Could not extract elements for storey: ${storeyName}`);
        }

        const dedupedElements = dedupeIfcStoreyElementsPreferFraming(storeyElements);
        if (dedupedElements.length !== storeyElements.length) {
          logger.info(
            `📐 Storey "${storeyName}": removed ${storeyElements.length - dedupedElements.length} duplicate IfcElementAssembly row(s) (kept Framing over Connections where both exist)`
          );
        }
        const finalElements = dedupedElements;
        const finalCount = finalElements.length;

        storeys.push({
          name: storeyName,
          elementCount: finalCount,
          elements: finalElements
        });

        logger.info(`📦 Storey: ${storeyName} (${elementCount} elements, ${storeyElements.length} panels extracted)`);
      }

      logger.info(`📊 Total elements: ${totalElements}, Element types: ${Object.keys(elementTypes).length}, Storeys: ${storeys.length}`);

      // Close model
      ifcApi.CloseModel(modelID);

      return {
        totalElements,
        storeys,
        elementTypes,
        spatialStructure: { storeys }
      };

    } catch (error: any) {
      logger.error('❌ IFC metadata extraction failed:', error);
      return {
        totalElements: 0,
        storeys: [],
        elementTypes: {},
        spatialStructure: {}
      };
    }
  }

  /**
   * Convert IFC file to Fragments format
   * @param ifcBuffer - IFC file buffer
   * @param onProgress - Progress callback (0-100)
   * @returns Fragments ArrayBuffer and extracted metadata
   */
  async convertIfcToFragments(
    ifcBuffer: Buffer,
    onProgress?: (progress: number, message: string) => void
  ): Promise<{
    fragmentsBuffer: Uint8Array;
    metadata: {
      totalElements: number;
      storeys: Array<{ name: string; elementCount: number }>;
      elementTypes: Record<string, number>;
      spatialStructure: any;
    };
  }> {
    try {
      // Ensure the serializer is initialized before conversion
      await this.ensureInitialized();

      const fileSizeMB = (ifcBuffer.length / 1024 / 1024).toFixed(2);
      logger.info(`🔄 Starting IFC → Fragments conversion (${fileSizeMB} MB)`);

      // Log memory before conversion
      const memBefore = process.memoryUsage();
      logger.info(`💾 Memory before conversion: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)} MB used / ${(memBefore.heapTotal / 1024 / 1024).toFixed(2)} MB total`);

      // STEP 1: Extract metadata from IFC BEFORE conversion
      logger.info('📊 Step 1: Extracting metadata from IFC file...');
      const metadata = await this.extractIfcMetadata(ifcBuffer);
      logger.info(`✅ Metadata extracted: ${metadata.totalElements} elements, ${metadata.storeys.length} storeys`);

      // Force garbage collection if available (run with --expose-gc flag)
      if (global.gc) {
        logger.info('🗑️ Running garbage collection before conversion...');
        global.gc();
      }

      // STEP 2: Convert IFC to Fragments
      logger.info('🔧 Step 2: Converting IFC to Fragments...');
      logger.warn('⚠️ Large file conversion may take several minutes and use significant memory');

      const ifcBytes = new Uint8Array(ifcBuffer);

      // Progress tracking
      let lastProgress = 0;
      const progressCallback = (progress: number, data: any) => {
        const percentage = Math.floor(progress * 100);
        if (percentage > lastProgress && percentage % 10 === 0) { // Log every 10%
          lastProgress = percentage;
          const memNow = process.memoryUsage();
          logger.info(`📊 Conversion progress: ${percentage}% | Memory: ${(memNow.heapUsed / 1024 / 1024).toFixed(2)} MB`);
          onProgress?.(percentage, `Converting IFC: ${percentage}%`);
        }
      };

      const fragmentsBuffer: Uint8Array = await (this.serializer as any).process({
        bytes: ifcBytes,
        progressCallback
      });

      // Log memory after conversion
      const memAfter = process.memoryUsage();
      logger.info(`💾 Memory after conversion: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)} MB used / ${(memAfter.heapTotal / 1024 / 1024).toFixed(2)} MB total`);
      logger.info(`✅ IFC converted to Fragments (${(fragmentsBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);

      // Cleanup
      if (global.gc) {
        logger.info('🗑️ Running garbage collection after conversion...');
        global.gc();
      }

      return {
        fragmentsBuffer,
        metadata
      };

    } catch (error: any) {
      logger.error('❌ IFC conversion failed:', error);
      logger.error(`Error details: ${error.stack}`);

      // Log memory on error
      const memError = process.memoryUsage();
      logger.error(`💾 Memory at error: ${(memError.heapUsed / 1024 / 1024).toFixed(2)} MB used / ${(memError.heapTotal / 1024 / 1024).toFixed(2)} MB total`);

      throw new Error(`IFC conversion failed: ${error.message}`);
    }
  }

  /**
   * Extract metadata from the IFC importer after conversion
   */
  private async extractMetadata(): Promise<{
    totalElements: number;
    storeys: Array<{ name: string; elementCount: number }>;
    elementTypes: Record<string, number>;
    spatialStructure: any;
  }> {
    try {
      // Access the spatial structure from the serializer (if available)
      // Note: IfcImporter may not expose these properties directly in all versions
      const spatialStructure = (this.serializer as any).spatialStructure || {};

      // Extract storeys
      const storeys: Array<{ name: string; elementCount: number }> = [];
      const elementTypes: Record<string, number> = {};
      let totalElements = 0;

      // Parse spatial structure to find storeys
      const parseNode = (node: any, depth: number = 0) => {
        if (!node) return;

        // Check if this is a storey
        const isStorey = node.category && (
          node.category.includes('STOREY') ||
          node.category.includes('BuildingStorey')
        );

        if (isStorey) {
          const storeyName = node.name || `Storey ${storeys.length + 1}`;
          const elementCount = node.children?.length || 0;

          storeys.push({
            name: storeyName,
            elementCount
          });

          logger.info(`📦 Found storey: ${storeyName} (${elementCount} elements)`);
        }

        // Count element types
        if (node.category && !isStorey) {
          const type = node.category;
          elementTypes[type] = (elementTypes[type] || 0) + 1;
          totalElements++;
        }

        // Recursively process children
        if (node.children && Array.isArray(node.children)) {
          for (const child of node.children) {
            parseNode(child, depth + 1);
          }
        }
      };

      // Parse the spatial structure
      parseNode(spatialStructure);

      // If no elements found, try alternative extraction
      if (totalElements === 0) {
        logger.warn('⚠️  No elements found in spatial structure, using alternative extraction');

        // Try to get items from serializer (if available)
        const serializerAny = this.serializer as any;
        if (serializerAny.items) {
          const items = Array.from(serializerAny.items.values());
          totalElements = items.length;

          items.forEach((item: any) => {
            const type = item.type || 'Unknown';
            elementTypes[type] = (elementTypes[type] || 0) + 1;
          });
        }
      }

      return {
        totalElements,
        storeys,
        elementTypes,
        spatialStructure
      };

    } catch (error: any) {
      logger.error('❌ Metadata extraction failed:', error);

      // Return minimal metadata on error
      return {
        totalElements: 0,
        storeys: [],
        elementTypes: {},
        spatialStructure: {}
      };
    }
  }

  /**
   * Validate IFC file
   */
  isValidIfc(buffer: Buffer): boolean {
    try {
      const header = buffer.toString('utf8', 0, 100);
      return header.includes('ISO-10303-21') || header.includes('IFC');
    } catch {
      return false;
    }
  }

  /**
   * Get IFC file info without full conversion
   */
  async getIfcInfo(ifcBuffer: Buffer): Promise<{
    version: string;
    schema: string;
    fileSize: number;
  }> {
    const header = ifcBuffer.toString('utf8', 0, 1000);

    // Extract IFC version
    const versionMatch = header.match(/FILE_SCHEMA\s*\(\s*\('([^']+)'\)/);
    const version = versionMatch ? versionMatch[1] : 'Unknown';

    return {
      version,
      schema: version,
      fileSize: ifcBuffer.length
    };
  }
}

// Export singleton instance
export const ifcConverter = new IfcConverterService();
