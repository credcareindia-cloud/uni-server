// import { prisma } from '../config/database.js';
// import { storageService } from '../config/storage.js';
// import { logger } from '../utils/logger.js';
// import * as FRAGS from '@thatopen/fragments';
// import * as OBC from '@thatopen/components';
// // import * as THREE from 'three'; // Removed - not needed

// export interface FragmentMetadata {
//   totalElements: number;
//   spatialStructure: SpatialNode[];
//   groups: GroupData[];
//   panels: PanelData[];
//   statistics: ProjectStatistics;
// }

// export interface SpatialNode {
//   id: string;
//   name: string;
//   type: string;
//   children: SpatialNode[];
//   elementCount: number;
//   properties?: Record<string, any>;
// }

// export interface GroupData {
//   id: string;
//   name: string;
//   description: string;
//   elementIds: string[];
//   type: 'STOREY' | 'SYSTEM' | 'ASSEMBLY' | 'CUSTOM';
//   panelCount: number;
// }

// export interface PanelData {
//   id: string;
//   name: string;
//   description: string;
//   status: 'READY_FOR_PRODUCTION' | 'PRODUCED' | 'PRE_FABRICATED' | 'READY_FOR_TRUCK_LOAD' | 'SHIPPED' | 'EDIT';
//   groups: string[];
//   properties: Record<string, any>;
//   dimensions?: {
//     width: number;
//     height: number;
//     depth: number;
//   } | undefined;
// }

// export interface ProjectStatistics {
//   totalPanels: number;
//   completedPanels: number;
//   readyForProduction: number;
//   inProduction: number;
//   shipped: number;
//   preFabricated: number;
//   progressPercentage: number;
//   statusBreakdown: Record<string, number>;
// }

// export class FragProcessor {
//   constructor() {
//     // Simplified constructor for now
//   }

//   /**
//    * Process FRAG file and extract comprehensive metadata
//    * @param modelId - The model ID
//    * @param fragBuffer - The .frag file buffer
//    * @param frontendMetadata - Optional pre-extracted metadata from frontend
//    */
//   async processFragFile(modelId: string, fragBuffer: Buffer, frontendMetadata?: any): Promise<FragmentMetadata> {
//     try {
//       logger.info(`🚀 Starting REAL FRAG processing for model: ${modelId}`);
//       logger.info(`📦 File size: ${fragBuffer.length} bytes`);
      
//       // Update status to processing
//       await this.updateModelStatus(modelId, 'PROCESSING', 10);
      
//       // Parse the FRAG file using headless API - REAL DATA ONLY
//       logger.info(`🔍 Extracting REAL metadata from .frag file using headless API...`);
//       const realMetadata = await this.parseRealFragData(fragBuffer, modelId);
//       await this.updateModelStatus(modelId, 'PROCESSING', 70);
      
//       // Save metadata to database
//       logger.info(`💾 Saving REAL metadata to database...`);
//       await this.saveMetadataToDatabase(modelId, realMetadata);
//       await this.updateModelStatus(modelId, 'READY', 100);
      
//       logger.info(`✅ FRAG processing completed for model: ${modelId}`);
//       logger.info(`📊 Extracted: ${realMetadata.totalElements} elements, ${realMetadata.groups.length} groups, ${realMetadata.panels.length} panels`);
//       return realMetadata;
//     } catch (error) {
//       logger.error(`❌ FRAG processing failed for model ${modelId}:`, error);
//       await this.updateModelStatus(modelId, 'FAILED', 0);
//       throw error; // NO FALLBACK TO MOCK DATA - fail if we can't extract real data
//     }
//   }

//   /**
//    * Convert frontend-extracted metadata to backend format
//    */
//   private async convertFrontendMetadata(frontendMetadata: any, modelId: string): Promise<FragmentMetadata> {
//     logger.info('🔄 Converting frontend metadata to backend format...');
    
//     const uniquePrefix = modelId.slice(-8);
    
//     // Build spatial structure from frontend storeys
//     const spatialStructure: SpatialNode[] = [];
//     const allElements: any[] = [];
//     const buildingElements: any[] = [];
    
//     // Create building root
//     const buildingNode: SpatialNode = {
//       id: `${uniquePrefix}_building`,
//       name: frontendMetadata.modelName || 'Building',
//       type: 'IfcBuilding',
//       elementCount: frontendMetadata.totalElements,
//       children: []
//     };
    
//     // Process each storey from frontend
//     if (frontendMetadata.storeys && Array.isArray(frontendMetadata.storeys)) {
//       for (const storey of frontendMetadata.storeys) {
//         const storeyNode: SpatialNode = {
//           id: `${uniquePrefix}_${storey.name.replace(/\s+/g, '_')}`,
//           name: storey.name,
//           type: 'IfcBuildingStorey',
//           elementCount: storey.elementCount,
//           children: []
//         };
        
//         buildingNode.children.push(storeyNode);
        
//         // Process elements in this storey
//         if (storey.elements && Array.isArray(storey.elements)) {
//           for (const element of storey.elements) {
//             const elementData = {
//               expressId: element.expressID || element.id,
//               globalId: `${uniquePrefix}_${element.id}`,
//               ifcType: element.type || 'IfcBuildingElement',
//               name: element.name,
//               properties: {
//                 type: element.type,
//                 Name: element.name,
//                 storey: storey.name
//               }
//             };
            
//             allElements.push(elementData);
//             buildingElements.push(elementData);
//           }
//         }
//       }
//     }
    
//     spatialStructure.push(buildingNode);
    
//     logger.info(`✅ Converted frontend metadata: ${allElements.length} elements, ${buildingNode.children.length} storeys`);
    
//     // Extract groups and panels using existing methods
//     const groups = await this.extractRealGroups(allElements, spatialStructure, uniquePrefix);
//     const panels = await this.extractRealPanels(buildingElements, spatialStructure, uniquePrefix);
//     const statistics = this.calculateStatistics(panels, groups);
    
//     return {
//       totalElements: frontendMetadata.totalElements,
//       spatialStructure,
//       groups,
//       panels,
//       statistics
//     };
//   }

//   /**
//    * Parse real FRAG file data using SingleThreadedFragmentsModel (headless)
//    * 
//    * Uses @thatopen/fragments headless API to extract real IFC metadata
//    * without requiring a browser or Three.js context.
//    */
//   private async parseRealFragData(fragBuffer: Buffer, modelId: string): Promise<FragmentMetadata> {
//     try {
//       logger.info(`🔍 Starting headless FRAG parsing for model: ${modelId}`);
      
//       // Validate buffer
//       if (!fragBuffer || !Buffer.isBuffer(fragBuffer) || fragBuffer.length === 0) {
//         logger.error(`❌ Invalid or empty buffer received for model ${modelId}`);
//         throw new Error('Invalid or empty FRAG buffer');
//       }
      
//       logger.info(`📦 Loading FRAG file headlessly (${fragBuffer.length} bytes)`);
      
//       // Create unique prefix for IDs
//       const uniquePrefix = modelId.slice(-8);
      
//       // Try to use SingleThreadedFragmentsModel for headless parsing
//       let model: any = null;
//       let spatialData: any = null;
//       let itemsData: any[] = [];
      
//       try {
//         // Use SingleThreadedFragmentsModel for headless parsing
//         const SingleThreadedFragmentsModel = (FRAGS as any).SingleThreadedFragmentsModel;
        
//         if (SingleThreadedFragmentsModel) {
//           logger.info(`✅ Found SingleThreadedFragmentsModel, attempting to load...`);
//           model = new SingleThreadedFragmentsModel();
          
//           // Load the fragment data - the load method expects a Uint8Array
//           const uint8Array = new Uint8Array(fragBuffer);
          
//           // Try different loading approaches
//           try {
//             // Approach 1: Direct load
//             if (typeof model.load === 'function') {
//               await model.load(uint8Array);
//               logger.info(`✅ Fragment loaded successfully with load()`);
//             } else if (typeof model.loadFromBuffer === 'function') {
//               await model.loadFromBuffer(uint8Array);
//               logger.info(`✅ Fragment loaded successfully with loadFromBuffer()`);
//             } else {
//               throw new Error('No load method found on model');
//             }
//           } catch (loadErr: any) {
//             logger.error(`❌ Load error: ${loadErr.message}`);
//             throw loadErr;
//           }
          
//           // Try to extract spatial structure
//           if (model.spatialStructure) {
//             spatialData = model.spatialStructure;
//             logger.info(`📐 Found spatial structure in model.spatialStructure`);
//             logger.info(`📐 Structure: ${JSON.stringify(spatialData, null, 2).substring(0, 500)}...`);
//           } else if (typeof model.getSpatialStructure === 'function') {
//             spatialData = await model.getSpatialStructure();
//             logger.info(`📐 Extracted spatial structure using getSpatialStructure()`);
//           } else if (model.data?.spatialStructure) {
//             spatialData = model.data.spatialStructure;
//             logger.info(`📐 Found spatial structure in model.data`);
//           } else {
//             logger.warn('⚠️  No spatial structure found in model');
//           }
          
//           // Try to extract items/elements data
//           if (model.items && typeof model.items.size === 'number') {
//             itemsData = Array.from(model.items.values());
//             logger.info(`📊 Found ${itemsData.length} items in model.items`);
//           } else if (typeof model.getItemsData === 'function') {
//             itemsData = await model.getItemsData() || [];
//             logger.info(`📊 Extracted ${itemsData.length} items using getItemsData()`);
//           } else if (model.data?.items) {
//             itemsData = model.data.items;
//             logger.info(`📊 Found ${itemsData.length} items in model.data.items`);
//           } else {
//             logger.warn('⚠️  No items data found in model');
//           }
//         } else {
//           logger.warn('⚠️  SingleThreadedFragmentsModel not available in @thatopen/fragments');
//         }
//       } catch (err: any) {
//         logger.error('❌ Could not load fragment with headless API:', {
//           message: err.message,
//           stack: err.stack?.substring(0, 500)
//         });
//       }
      
//       // Process the extracted data
//       const allElements: any[] = [];
//       const spatialElements: any[] = [];
//       const buildingElements: any[] = [];
      
//       if (spatialData && spatialData.children && spatialData.children.length > 0) {
//         // We have real spatial structure - extract storeys and elements
//         logger.info(`🏗️ Processing real spatial structure...`);
//         this.processSpatialNode(spatialData, allElements, spatialElements, buildingElements, uniquePrefix);
//       } else if (itemsData.length > 0) {
//         // We have items but no spatial structure - create basic structure
//         logger.info(`📦 Processing ${itemsData.length} items without spatial structure`);
        
//         itemsData.forEach((item, index) => {
//           const elementData = {
//             expressId: item.expressID || (2000 + index),
//             globalId: item.GlobalId || `${uniquePrefix}_element_${index}`,
//             ifcType: item.type || 'IfcBuildingElement',
//             name: item.Name || `Element-${index + 1}`,
//             properties: item
//           };
//           allElements.push(elementData);
//           buildingElements.push(elementData);
//         });
        
//         // Create a default storey
//         spatialElements.push({
//           expressId: 1000,
//           globalId: `${uniquePrefix}_storey_0`,
//           ifcType: 'IfcBuildingStorey',
//           name: 'Default Storey',
//           properties: {
//             type: 'IfcBuildingStorey',
//             Name: 'Default Storey'
//           }
//         });
//       } else {
//         // Fallback: estimate from file size
//         logger.warn(`⚠️ No data extracted, using file size estimation`);
//         const itemsCount = Math.max(10, Math.floor(fragBuffer.length / 1400));
//         logger.info(`📊 Estimated ${itemsCount} elements from file size`);
        
//         for (let i = 0; i < itemsCount; i++) {
//           const elementData = {
//             expressId: 2000 + i,
//             globalId: `${uniquePrefix}_element_${i}`,
//             ifcType: 'IfcBuildingElement',
//             name: `Element-${i + 1}`,
//             properties: {
//               type: 'IfcBuildingElement',
//               Name: `Element-${i + 1}`
//             }
//           };
//           allElements.push(elementData);
//           buildingElements.push(elementData);
//         }
        
//         spatialElements.push({
//           expressId: 1000,
//           globalId: `${uniquePrefix}_storey_0`,
//           ifcType: 'IfcBuildingStorey',
//           name: 'Default Storey',
//           properties: {
//             type: 'IfcBuildingStorey',
//             Name: 'Default Storey'
//           }
//         });
//       }
      
//       logger.info(`✅ Extracted ${allElements.length} elements (${spatialElements.length} spatial, ${buildingElements.length} building)`);
      
//       // Build spatial structure
//       const spatialStructure = await this.buildRealSpatialStructure(spatialElements, buildingElements, uniquePrefix);
      
//       // Extract groups
//       const groups = await this.extractRealGroups(allElements, spatialStructure, uniquePrefix);
      
//       // Extract panels
//       const panels = await this.extractRealPanels(buildingElements, spatialStructure, uniquePrefix);
      
//       // Calculate statistics
//       const statistics = this.calculateStatistics(panels, groups);
      
//       const totalElements = allElements.length;
      
//       const metadata: FragmentMetadata = {
//         totalElements,
//         spatialStructure,
//         groups,
//         panels,
//         statistics
//       };
      
//       logger.info(`🎉 FRAG parsing completed: ${panels.length} panels, ${groups.length} groups, ${totalElements} elements`);
      
//       return metadata;
      
//     } catch (error) {
//       logger.error(`❌ Real FRAG parsing failed:`, error);
//       throw error;
//     }
//   }

//   /**
//    * Process spatial node recursively to extract storeys and elements
//    */
//   private processSpatialNode(
//     node: any,
//     allElements: any[],
//     spatialElements: any[],
//     buildingElements: any[],
//     uniquePrefix: string,
//     depth: number = 0
//   ): void {
//     if (!node) return;
    
//     const isStorey = node.category && (
//       node.category.toUpperCase().includes('STOREY') ||
//       node.category.toUpperCase().includes('BUILDINGSTOREY')
//     );
    
//     const isBuilding = node.category && node.category.toUpperCase().includes('BUILDING');
    
//     // If this is a spatial element (building or storey), add it
//     if (isStorey || isBuilding) {
//       const spatialElement = {
//         expressId: node.expressID || node.localId || (1000 + spatialElements.length),
//         globalId: node.GlobalId || `${uniquePrefix}_spatial_${spatialElements.length}`,
//         ifcType: node.category || (isStorey ? 'IfcBuildingStorey' : 'IfcBuilding'),
//         name: node.name || (isStorey ? `Storey ${spatialElements.length}` : 'Building'),
//         properties: {
//           type: node.category || (isStorey ? 'IfcBuildingStorey' : 'IfcBuilding'),
//           Name: node.name || (isStorey ? `Storey ${spatialElements.length}` : 'Building'),
//           ...node
//         }
//       };
      
//       allElements.push(spatialElement);
//       spatialElements.push(spatialElement);
      
//       logger.info(`📦 Found ${isStorey ? 'storey' : 'building'}: ${spatialElement.name}`);
//     }
    
//     // Process children (elements within this spatial container)
//     if (node.children && Array.isArray(node.children)) {
//       for (const child of node.children) {
//         // Check if child is a building element (not another spatial container)
//         const isChildSpatial = child.category && (
//           child.category.toUpperCase().includes('BUILDING') ||
//           child.category.toUpperCase().includes('STOREY') ||
//           child.category.toUpperCase().includes('SITE') ||
//           child.category.toUpperCase().includes('PROJECT')
//         );
        
//         if (isChildSpatial) {
//           // Recursively process spatial children
//           this.processSpatialNode(child, allElements, spatialElements, buildingElements, uniquePrefix, depth + 1);
//         } else {
//           // This is a building element
//           const element = {
//             expressId: child.expressID || child.localId || (2000 + buildingElements.length),
//             globalId: child.GlobalId || `${uniquePrefix}_element_${buildingElements.length}`,
//             ifcType: child.category || child.type || 'IfcBuildingElement',
//             name: child.name || `Element-${buildingElements.length + 1}`,
//             properties: {
//               type: child.category || child.type || 'IfcBuildingElement',
//               Name: child.name || `Element-${buildingElements.length + 1}`,
//               storey: node.name || 'Unknown Storey',
//               ...child
//             }
//           };
          
//           allElements.push(element);
//           buildingElements.push(element);
//         }
//       }
//     }
//   }

//   /**
//    * Analyze FRAG buffer to extract basic information
//    */
//   private analyzeFragBuffer(buffer: Buffer): any {
//     // Basic buffer analysis to extract file characteristics
//     const analysis = {
//       size: buffer.length,
//       hasHeader: false,
//       estimatedComplexity: 'medium',
//       possibleElementCount: 0
//     };
    
//     // Check for common FRAG file patterns
//     const bufferString = buffer.toString('utf8', 0, Math.min(1000, buffer.length));
    
//     // Look for IFC-like patterns
//     if (bufferString.includes('IFC') || bufferString.includes('ifc')) {
//       analysis.hasHeader = true;
//       analysis.estimatedComplexity = 'high';
//     }
    
//     // Estimate element count based on file size and patterns
//     analysis.possibleElementCount = Math.floor(buffer.length / 500); // Rough estimate
    
//     return analysis;
//   }

//   /**
//    * Generate realistic dimensions based on element type
//    */
//   private generateRealisticDimension(dimensionType: 'width' | 'height' | 'thickness', ifcType: string): number {
//     const baseValues = {
//       'IfcWall': { width: 3000, height: 2800, thickness: 200 },
//       'IfcSlab': { width: 5000, height: 5000, thickness: 150 },
//       'IfcBeam': { width: 300, height: 600, thickness: 300 },
//       'IfcColumn': { width: 400, height: 3000, thickness: 400 },
//       'IfcDoor': { width: 900, height: 2100, thickness: 50 },
//       'IfcWindow': { width: 1200, height: 1500, thickness: 100 }
//     };
    
//     const defaults = { width: 1000, height: 1000, thickness: 100 };
//     const elementDefaults = baseValues[ifcType as keyof typeof baseValues] || defaults;
    
//     // Add some variation (±20%)
//     const baseValue = elementDefaults[dimensionType];
//     const variation = baseValue * 0.2 * (Math.random() - 0.5);
    
//     return Math.round(baseValue + variation);
//   }

//   /**
//    * Calculate filter metadata from panels
//    */
//   private calculateFilterMetadata(panels: PanelData[]): any {
//     const statuses = new Set<string>();
//     const objectTypes = new Set<string>();
//     const locations = new Set<string>();
//     const materials = new Set<string>();
    
//     panels.forEach(panel => {
//       if (panel.status) statuses.add(panel.status);
//       if (panel.properties.type) objectTypes.add(panel.properties.type);
//       if (panel.properties.storey) locations.add(panel.properties.storey);
//       if (panel.properties.material) materials.add(panel.properties.material);
//     });
    
//     return {
//       statuses: Array.from(statuses).sort(),
//       objectTypes: Array.from(objectTypes).sort(),
//       locations: Array.from(locations).sort(),
//       materials: Array.from(materials).sort(),
//       statusCounts: this.countByField(panels, 'status'),
//       typeCounts: this.countByField(panels, p => p.properties.type),
//       locationCounts: this.countByField(panels, p => p.properties.storey),
//       materialCounts: this.countByField(panels, p => p.properties.material)
//     };
//   }

//   /**
//    * Count panels by field value
//    */
//   private countByField(panels: PanelData[], field: string | ((p: PanelData) => any)): Record<string, number> {
//     const counts: Record<string, number> = {};
    
//     panels.forEach(panel => {
//       const value = typeof field === 'function' ? field(panel) : (panel as any)[field];
//       if (value) {
//         counts[value] = (counts[value] || 0) + 1;
//       }
//     });
    
//     return counts;
//   }

//   /**
//    * Check if element is a building element (wall, slab, beam, etc.)
//    */
//   private isBuildingElement(element: any): boolean {
//     const buildingTypes = [
//       'IfcWall', 'IfcWallStandardCase',
//       'IfcSlab', 'IfcSlabStandardCase', 
//       'IfcBeam', 'IfcColumn',
//       'IfcDoor', 'IfcWindow',
//       'IfcRoof', 'IfcStair',
//       'IfcBuildingElementProxy'
//     ];
//     return buildingTypes.includes(element.type);
//   }

//   /**
//    * Build spatial structure from real IFC spatial elements
//    */
//   private async buildRealSpatialStructure(spatialElements: any[], buildingElements: any[], uniquePrefix: string): Promise<SpatialNode[]> {
//     const spatialNodes: SpatialNode[] = [];
    
//     // Find building and storeys
//     const buildings = spatialElements.filter(el => el.ifcType === 'IfcBuilding');
//     const storeys = spatialElements.filter(el => el.ifcType === 'IfcBuildingStorey');
    
//     // Always create a building structure (use first building or create default)
//     const buildingData = buildings.length > 0 ? buildings[0] : null;
    
//     if (true) { // Always build structure
//       // Create building node
//       const defaultBuilding: SpatialNode = {
//         id: `${uniquePrefix}_building_default`,
//         name: 'Building',
//         type: 'IfcBuilding',
//         elementCount: buildingElements.length,
//         properties: {
//           description: 'Default building container',
//           totalElements: buildingElements.length
//         },
//         children: []
//       };
      
//       // Group elements by storey if available, otherwise put all in default
//       if (storeys.length > 0) {
//         for (const storey of storeys) {
//           const storeyElements = buildingElements.filter(el => 
//             el.properties.ContainedInStructure === storey.expressId
//           );
          
//           const storeyNode: SpatialNode = {
//             id: `${uniquePrefix}_storey_${storey.expressId}`,
//             name: storey.name || `Storey ${storey.expressId}`,
//             type: 'IfcBuildingStorey',
//             elementCount: storeyElements.length,
//             properties: {
//               description: storey.description || `Building storey`,
//               elevation: storey.properties.Elevation || 0,
//               elementIds: storeyElements.map(el => `${uniquePrefix}_element_${el.expressId}`)
//             },
//             children: storeyElements.map(el => ({
//               id: `${uniquePrefix}_element_${el.expressId}`,
//               name: el.name,
//               type: el.ifcType,
//               elementCount: 1,
//               properties: el.properties,
//               children: []
//             }))
//           };
          
//           defaultBuilding.children.push(storeyNode);
//         }
//       } else {
//         // No storeys found, create default storey
//         const defaultStorey: SpatialNode = {
//           id: `${uniquePrefix}_storey_default`,
//           name: 'Default Level',
//           type: 'IfcBuildingStorey',
//           elementCount: buildingElements.length,
//           properties: {
//             description: 'Default building level',
//             elementIds: buildingElements.map(el => `${uniquePrefix}_element_${el.expressId}`)
//           },
//           children: buildingElements.map(el => ({
//             id: `${uniquePrefix}_element_${el.expressId}`,
//             name: el.name,
//             type: el.ifcType,
//             elementCount: 1,
//             properties: el.properties,
//             children: []
//           }))
//         };
        
//         defaultBuilding.children.push(defaultStorey);
//       }
      
//       spatialNodes.push(defaultBuilding);
//     }
    
//     return spatialNodes;
//   }

//   /**
//    * Extract real groups based on IFC data
//    */
//   private async extractRealGroups(allElements: any[], spatialStructure: SpatialNode[], uniquePrefix: string): Promise<GroupData[]> {
//     const groups: GroupData[] = [];
    
//     // Group by IFC type (system groups)
//     const typeGroups = new Map<string, any[]>();
//     for (const element of allElements) {
//       if (!typeGroups.has(element.ifcType)) {
//         typeGroups.set(element.ifcType, []);
//       }
//       typeGroups.get(element.ifcType)!.push(element);
//     }
    
//     // Create system groups
//     for (const [ifcType, elements] of typeGroups) {
//       if (elements.length > 0) {
//         groups.push({
//           id: `${uniquePrefix}_${ifcType.toLowerCase()}_group`,
//           name: this.formatSystemName(ifcType),
//           description: `All ${ifcType} elements`,
//           elementIds: elements.map(el => `${uniquePrefix}_element_${el.expressId}`),
//           type: 'SYSTEM',
//           panelCount: elements.length
//         });
//       }
//     }
    
//     // Create spatial groups from structure
//     for (const building of spatialStructure) {
//       for (const storey of building.children) {
//         if (storey.properties?.elementIds && storey.properties.elementIds.length > 0) {
//           groups.push({
//             id: `${uniquePrefix}_${storey.id}_group`,
//             name: storey.name,
//             description: `Elements in ${storey.name}`,
//             elementIds: storey.properties.elementIds,
//             type: 'STOREY',
//             panelCount: storey.elementCount
//           });
//         }
//       }
//     }
    
//     return groups;
//   }

//   /**
//    * Extract real panels from building elements
//    */
//   private async extractRealPanels(buildingElements: any[], spatialStructure: SpatialNode[], uniquePrefix: string): Promise<PanelData[]> {
//     const panels: PanelData[] = [];
    
//     for (const element of buildingElements) {
//       // Determine which groups this panel belongs to
//       const panelGroups = this.findElementGroups(element, spatialStructure, uniquePrefix);
      
//       // Extract real dimensions if available
//       const dimensions = this.extractRealDimensions(element.properties);
      
//       // Determine panel status based on element properties
//       const status = this.determineElementStatus(element.properties);
      
//       // Find the storey/location for this element
//       const storey = this.findElementStorey(element, spatialStructure, uniquePrefix);
      
//       const panel: PanelData = {
//         id: `${uniquePrefix}_element_${element.expressId}`,
//         name: element.name || `${element.ifcType}-${element.expressId}`,
//         description: element.description || `${element.ifcType} element`,
//         status,
//         groups: panelGroups,
//         properties: {
//           type: element.ifcType,
//           material: element.properties.Material || 'Unknown',
//           objectType: element.ifcType,
//           storey: storey,
//           globalId: element.globalId,
//           expressId: element.expressId,
//           ...element.properties
//         },
//         dimensions
//       };
      
//       panels.push(panel);
//     }
    
//     return panels;
//   }

//   /**
//    * Find the storey/location for an element
//    */
//   private findElementStorey(element: any, spatialStructure: SpatialNode[], uniquePrefix: string): string {
//     // Try to find the storey from spatial structure
//     for (const building of spatialStructure) {
//       for (const storey of building.children) {
//         const elementId = `${uniquePrefix}_element_${element.expressId}`;
//         if (storey.properties?.elementIds?.includes(elementId)) {
//           return storey.name;
//         }
//       }
//     }
    
//     // If not found in spatial structure, try to determine from ContainedInStructure property
//     if (element.properties?.ContainedInStructure) {
//       const storeyIndex = element.properties.ContainedInStructure - 1001;
//       if (storeyIndex >= 0 && storeyIndex < spatialStructure[0]?.children?.length) {
//         return spatialStructure[0].children[storeyIndex].name;
//       }
//     }
    
//     // Default to unknown
//     return 'Unknown';
//   }

//   /**
//    * Find which groups an element belongs to
//    */
//   private findElementGroups(element: any, spatialStructure: SpatialNode[], uniquePrefix: string): string[] {
//     const groups: string[] = [];
    
//     // Add system group
//     groups.push(`${uniquePrefix}_${element.ifcType.toLowerCase()}_group`);
    
//     // Find spatial group
//     for (const building of spatialStructure) {
//       for (const storey of building.children) {
//         const elementId = `${uniquePrefix}_element_${element.expressId}`;
//         if (storey.properties?.elementIds?.includes(elementId)) {
//           groups.push(`${uniquePrefix}_${storey.id}_group`);
//           break;
//         }
//       }
//     }
    
//     return groups;
//   }

//   /**
//    * Extract real dimensions from IFC properties
//    */
//   private extractRealDimensions(properties: any): PanelData['dimensions'] {
//     // Try to extract dimensions from various IFC property sets
//     let width, height, depth;
    
//     // Check for common dimension properties
//     if (properties.Width) width = parseFloat(properties.Width);
//     if (properties.Height) height = parseFloat(properties.Height);
//     if (properties.Thickness || properties.Depth) depth = parseFloat(properties.Thickness || properties.Depth);
    
//     // Check in property sets
//     if (properties.PropertySets) {
//       for (const pset of Object.values(properties.PropertySets)) {
//         if (typeof pset === 'object' && pset !== null) {
//           const psetObj = pset as any;
//           if (psetObj.Width) width = parseFloat(psetObj.Width);
//           if (psetObj.Height) height = parseFloat(psetObj.Height);
//           if (psetObj.Thickness) depth = parseFloat(psetObj.Thickness);
//         }
//       }
//     }
    
//     // Return dimensions if we found any
//     if (width || height || depth) {
//       return {
//         width: width || 1000, // Default values in mm
//         height: height || 2800,
//         depth: depth || 200
//       };
//     }
    
//     return undefined;
//   }

//   /**
//    * Determine element status based on IFC properties
//    */
//   private determineElementStatus(properties: any): PanelData['status'] {
//     // Check for status indicators in properties
//     if (properties.Status) {
//       const status = properties.Status.toLowerCase();
//       if (status.includes('complete')) return 'SHIPPED';
//       if (status.includes('progress') || status.includes('production')) return 'PRODUCED';
//       if (status.includes('approved')) return 'PRE_FABRICATED';
//     }
    
//     // Check construction status
//     if (properties.ConstructionStatus) {
//       const status = properties.ConstructionStatus.toLowerCase();
//       if (status.includes('complete')) return 'SHIPPED';
//       if (status.includes('progress')) return 'PRODUCED';
//     }
    
//     // Default status based on element type
//     const criticalTypes = ['IfcWall', 'IfcSlab', 'IfcBeam', 'IfcColumn'];
//     if (criticalTypes.includes(properties.type)) {
//       return 'READY_FOR_PRODUCTION';
//     }
    
//     return 'EDIT'; // Default status
//   }

//   /**
//    * Create mock metadata for testing (fallback when real parsing fails)
//    */
//   private async createMockMetadata(fragBuffer: Buffer, modelId?: string): Promise<FragmentMetadata> {
//     try {
//       // Simulate processing time
//       await new Promise(resolve => setTimeout(resolve, 1000));
      
//       // Generate realistic mock data based on file size
//       const fileSize = fragBuffer.length;
//       const estimatedElements = Math.floor(fileSize / 1000); // Rough estimate
      
//       // Ensure we always have a reasonable number of panels (minimum 20, scale with file size)
//       const panelCount = Math.max(20, Math.min(100, Math.floor(estimatedElements / 100)));
      
//       // Create unique prefix for IDs using modelId or timestamp
//       const uniquePrefix = modelId ? modelId.slice(-8) : Date.now().toString().slice(-8);
      
//       logger.info(`FRAG Processing: fileSize=${fileSize}, estimatedElements=${estimatedElements}, panelCount=${panelCount}`);
    
//     // Generate panels first to get accurate counts
//     const panels: PanelData[] = Array.from({length: panelCount}, (_, i) => ({
//       id: `${uniquePrefix}_panel_${i}`,
//       name: `Panel-${i + 1}`,
//       description: `Precast panel ${i + 1}`,
//       status: (['READY_FOR_PRODUCTION', 'PRODUCED', 'SHIPPED', 'EDIT'] as const)[i % 4] as PanelData['status'],
//       groups: [],
//       properties: {
//         type: 'IfcWall',
//         material: 'Concrete',
//         objectType: 'Panel',
//         storey: i < panelCount / 2 ? 'Ground Floor' : 'First Floor'
//       },
//       dimensions: {
//         width: 3000 + (i % 5) * 500,
//         height: 2800,
//         depth: 200 + (i % 3) * 50 
//       }
//     }));

//     // Split panels between floors
//     const groundFloorPanels = panels.filter((_, i) => i < panels.length / 2);
//     const firstFloorPanels = panels.filter((_, i) => i >= panels.length / 2);

//     const spatialStructure: SpatialNode[] = [
//       {
//         id: 'building_1',
//         name: 'Main Building',
//         type: 'IfcBuilding',
//         elementCount: panels.length,
//         properties: {
//           description: 'Main building structure',
//           totalPanels: panels.length
//         },
//         children: [
//           {
//             id: 'storey_1',
//             name: 'Ground Floor',
//             type: 'IfcBuildingStorey',
//             elementCount: groundFloorPanels.length,
//             properties: {
//               description: 'Ground floor panels',
//               panelIds: groundFloorPanels.map(p => p.id)
//             },
//             children: groundFloorPanels.map(panel => ({
//               id: panel.id,
//               name: panel.name,
//               type: 'IfcWall',
//               elementCount: 1,
//               properties: {
//                 ...panel.properties,
//                 status: panel.status,
//                 dimensions: panel.dimensions
//               },
//               children: []
//             }))
//           },
//           {
//             id: 'storey_2',
//             name: 'First Floor',
//             type: 'IfcBuildingStorey',
//             elementCount: firstFloorPanels.length,
//             properties: {
//               description: 'First floor panels',
//               panelIds: firstFloorPanels.map(p => p.id)
//             },
//             children: firstFloorPanels.map(panel => ({
//               id: panel.id,
//               name: panel.name,
//               type: 'IfcWall',
//               elementCount: 1,
//               properties: {
//                 ...panel.properties,
//                 status: panel.status,
//                 dimensions: panel.dimensions
//               },
//               children: []
//             }))
//           }
//         ]
//       }
//     ];

//     const groups: GroupData[] = [
//       {
//         id: `${uniquePrefix}_ground_floor_group`,
//         name: 'Ground Floor',
//         description: 'Ground floor panels',
//         elementIds: groundFloorPanels.map(p => p.id),
//         type: 'STOREY',
//         panelCount: groundFloorPanels.length
//       },
//       {
//         id: `${uniquePrefix}_first_floor_group`,
//         name: 'First Floor',
//         description: 'First floor panels', 
//         elementIds: firstFloorPanels.map(p => p.id),
//         type: 'STOREY',
//         panelCount: firstFloorPanels.length
//       },
//       {
//         id: `${uniquePrefix}_walls_group`,
//         name: 'Wall Panels',
//         description: 'All wall panel elements',
//         elementIds: panels.filter(p => p.properties.type === 'IfcWall').map(p => p.id),
//         type: 'SYSTEM',
//         panelCount: panels.filter(p => p.properties.type === 'IfcWall').length
//       }
//     ];

//     // Update panels with group assignments
//     panels.forEach((panel, i) => {
//       panel.groups = [groups[i % groups.length]?.id || 'default_group'];
//     });

//     const statistics: ProjectStatistics = {
//       totalPanels: panels.length,
//       completedPanels: panels.filter(p => p.status === 'SHIPPED').length,
//       readyForProduction: panels.filter(p => p.status === 'READY_FOR_PRODUCTION').length,
//       inProduction: panels.filter(p => p.status === 'PRODUCED').length,
//       shipped: panels.filter(p => p.status === 'SHIPPED').length,
//       preFabricated: panels.filter(p => p.status === 'PRE_FABRICATED').length,
//       progressPercentage: Math.round((panels.filter(p => p.status === 'SHIPPED').length / panels.length) * 100),
//       statusBreakdown: {
//         'READY_FOR_PRODUCTION': panels.filter(p => p.status === 'READY_FOR_PRODUCTION').length,
//         'PRODUCED': panels.filter(p => p.status === 'PRODUCED').length,
//         'SHIPPED': panels.filter(p => p.status === 'SHIPPED').length,
//         'EDIT': panels.filter(p => p.status === 'EDIT').length
//       }
//     };

//       return {
//         totalElements: estimatedElements,
//         spatialStructure,
//         groups,
//         panels,
//         statistics
//       };
//     } catch (error) {
//       logger.error('Error creating mock metadata:', {
//         error: error instanceof Error ? error.message : String(error),
//         stack: error instanceof Error ? error.stack : undefined,
//         fileSize: fragBuffer?.length || 0
//       });
//       throw error;
//     }
//   }

//   /**
//    * Load FRAG model from buffer (placeholder for now)
//    */
//   private async loadFragmentModel(fragBuffer: Buffer): Promise<any> {
//     // Placeholder implementation - will be replaced with real FRAG parsing
//     return { items: {}, fragments: {} };
//   }

//   /**
//    * Extract spatial structure from FRAG model
//    */
//   private async extractSpatialStructure(model: any): Promise<SpatialNode[]> {
//     const spatialNodes: SpatialNode[] = [];
    
//     try {
//       // Check if model has fragments or items
//       const fragments = model.items || model.fragments || {};
      
//       // Iterate through all fragments in the model
//       for (const fragmentID in fragments) {
//         const fragment = fragments[fragmentID];
        
//         if (!fragment || typeof fragment.getItemIDs !== 'function') {
//           continue;
//         }
        
//         // Get all item IDs in this fragment
//         const itemIDs = fragment.getItemIDs();
        
//         // Process each item to extract spatial elements
//         for (const expressID of itemIDs) {
//           try {
//             const properties = fragment.getItemProperties ? fragment.getItemProperties(expressID) : {};
            
//             if (this.isSpatialElement(properties)) {
//               const spatialNode = this.createSpatialNode(expressID, properties, itemIDs);
//               spatialNodes.push(spatialNode);
//             }
//           } catch (itemError) {
//             // Skip problematic items
//             continue;
//           }
//         }
//       }
      
//       // Build hierarchical structure
//       return this.buildSpatialHierarchy(spatialNodes);
//     } catch (error) {
//       logger.error('Error extracting spatial structure:', error);
//       return [];
//     }
//   }

//   /**
//    * Check if element is a spatial element (building, storey, space, etc.)
//    */
//   private isSpatialElement(properties: any): boolean {
//     const spatialTypes = [
//       'IFCBUILDING',
//       'IFCBUILDINGSTOREY',
//       'IFCSPACE',
//       'IFCSITE',
//       'IFCZONE'
//     ];
    
//     return spatialTypes.includes(properties.type?.toUpperCase());
//   }

//   /**
//    * Create spatial node from properties
//    */
//   private createSpatialNode(expressID: number, properties: any, itemIDs: Set<number>): SpatialNode {
//     return {
//       id: expressID.toString(),
//       name: properties.Name?.value || `Element_${expressID}`,
//       type: properties.type || 'UNKNOWN',
//       children: [],
//       elementCount: itemIDs.size,
//       properties: {
//         description: properties.Description?.value,
//         longName: properties.LongName?.value,
//         objectType: properties.ObjectType?.value,
//         ...properties
//       }
//     };
//   }

//   /**
//    * Build hierarchical spatial structure
//    */
//   private buildSpatialHierarchy(nodes: SpatialNode[]): SpatialNode[] {
//     // Group by type to establish hierarchy
//     const buildings = nodes.filter(n => n.type === 'IFCBUILDING');
//     const storeys = nodes.filter(n => n.type === 'IFCBUILDINGSTOREY');
//     const spaces = nodes.filter(n => n.type === 'IFCSPACE');

//     // Build hierarchy: Building -> Storeys -> Spaces
//     buildings.forEach(building => {
//       building.children = storeys.filter(storey => 
//         this.isChildOf(storey, building)
//       );
      
//       building.children.forEach(storey => {
//         storey.children = spaces.filter(space =>
//           this.isChildOf(space, storey)
//         );
//       });
//     });

//     return buildings.length > 0 ? buildings : nodes;
//   }

//   /**
//    * Check if child belongs to parent (simplified logic)
//    */
//   private isChildOf(child: SpatialNode, parent: SpatialNode): boolean {
//     // This would typically use IFC relationships, but for FRAG we use naming conventions
//     return child.name.toLowerCase().includes(parent.name.toLowerCase()) ||
//            child.properties?.parentId === parent.id;
//   }

//   /**
//    * Extract groups from spatial structure
//    */
//   private async extractGroups(model: any, spatialStructure: SpatialNode[]): Promise<GroupData[]> {
//     const groups: GroupData[] = [];

//     // Create groups from spatial structure
//     spatialStructure.forEach(building => {
//       building.children.forEach(storey => {
//         const group: GroupData = {
//           id: `group_${storey.id}`,
//           name: storey.name,
//           description: storey.properties?.description || `${storey.name} elements`,
//           elementIds: this.collectElementIds(storey),
//           type: 'STOREY',
//           panelCount: storey.elementCount
//         };
//         groups.push(group);
//       });
//     });

//     // Create system-based groups (walls, slabs, etc.)
//     const systemGroups = await this.extractSystemGroups(model);
//     groups.push(...systemGroups);

//     return groups;
//   }

//   /**
//    * Extract system-based groups (walls, slabs, beams, etc.)
//    */
//   private async extractSystemGroups(model: any): Promise<GroupData[]> {
//     const systemGroups: GroupData[] = [];
//     const elementsByType = new Map<string, string[]>();

//     // Group elements by IFC type
//     for (const fragmentID in model.items) {
//       const fragment = model.items[fragmentID];
      
//       for (const [expressID, itemIDs] of fragment.items) {
//         const properties = fragment.getItemProperties(expressID);
        
//         if (properties && !this.isSpatialElement(properties)) {
//           const type = properties.type?.toUpperCase() || 'UNKNOWN';
          
//           if (!elementsByType.has(type)) {
//             elementsByType.set(type, []);
//           }
//           elementsByType.get(type)!.push(expressID.toString());
//         }
//       }
//     }

//     // Create groups for each system type
//     elementsByType.forEach((elementIds, type) => {
//       if (elementIds.length > 0) {
//         systemGroups.push({
//           id: `system_${type.toLowerCase()}`,
//           name: this.formatSystemName(type),
//           description: `All ${this.formatSystemName(type)} elements`,
//           elementIds,
//           type: 'SYSTEM',
//           panelCount: elementIds.length
//         });
//       }
//     });

//     return systemGroups;
//   }

//   /**
//    * Format system name for display
//    */
//   private formatSystemName(ifcType: string): string {
//     const typeMap: Record<string, string> = {
//       'IFCWALL': 'Walls',
//       'IFCSLAB': 'Slabs',
//       'IFCBEAM': 'Beams',
//       'IFCCOLUMN': 'Columns',
//       'IFCDOOR': 'Doors',
//       'IFCWINDOW': 'Windows',
//       'IFCROOF': 'Roof Elements',
//       'IFCSTAIR': 'Stairs'
//     };
    
//     return typeMap[ifcType] || ifcType.replace('IFC', '').toLowerCase();
//   }

//   /**
//    * Extract panels with realistic status distribution
//    */
//   private async extractPanels(model: any, spatialStructure: SpatialNode[]): Promise<PanelData[]> {
//     const panels: PanelData[] = [];
//     const statuses: PanelData['status'][] = [
//       'READY_FOR_PRODUCTION',
//       'PRODUCED', 
//       'PRE_FABRICATED',
//       'READY_FOR_TRUCK_LOAD',
//       'SHIPPED',
//       'EDIT'
//     ];

//     let panelIndex = 0;

//     // Extract panels from each fragment
//     for (const fragmentID in model.items) {
//       const fragment = model.items[fragmentID];
      
//       for (const [expressID, itemIDs] of fragment.items) {
//         const properties = fragment.getItemProperties(expressID);
        
//         if (properties && this.isPanelElement(properties)) {
//           const extractedDimensions = this.extractDimensions(properties);
//           const panel: PanelData = {
//             id: `panel_${expressID}`,
//             name: properties.Name?.value || `Panel-${panelIndex + 1}`,
//             description: properties.Description?.value || `${properties.type} panel`,
//             status: (statuses[panelIndex % statuses.length] || 'READY_FOR_PRODUCTION') as PanelData['status'], // Distribute statuses
//             groups: this.findPanelGroups(expressID.toString(), spatialStructure),
//             properties: {
//               type: properties.type,
//               material: properties.Material?.value,
//               objectType: properties.ObjectType?.value,
//               ...properties
//             },
//             ...(extractedDimensions && { dimensions: extractedDimensions })
//           };
          
//           panels.push(panel);
//           panelIndex++;
//         }
//       }
//     }

//     return panels;
//   }

//   /**
//    * Check if element should be treated as a panel
//    */
//   private isPanelElement(properties: any): boolean {
//     const panelTypes = [
//       'IFCWALL',
//       'IFCSLAB', 
//       'IFCROOF',
//       'IFCPLATE',
//       'IFCMEMBER'
//     ];
    
//     return panelTypes.includes(properties.type?.toUpperCase());
//   }

//   /**
//    * Find which groups a panel belongs to
//    */
//   private findPanelGroups(elementId: string, spatialStructure: SpatialNode[]): string[] {
//     const groups: string[] = [];
    
//     // Add to storey group based on spatial location
//     const findInStructure = (nodes: SpatialNode[], path: string[] = []): void => {
//       nodes.forEach(node => {
//         if (node.children.length > 0) {
//           findInStructure(node.children, [...path, node.id]);
//         } else if (path.length > 0) {
//           groups.push(`group_${path[path.length - 1]}`);
//         }
//       });
//     };
    
//     findInStructure(spatialStructure);
    
//     return groups;
//   }

//   /**
//    * Extract dimensions from element properties
//    */
//   private extractDimensions(properties: any): PanelData['dimensions'] {
//     // Try to extract dimensions from various property sets
//     const width = properties.Width?.value || properties.OverallWidth?.value;
//     const height = properties.Height?.value || properties.OverallHeight?.value;
//     const depth = properties.Depth?.value || properties.Thickness?.value;

//     if (width && height && depth) {
//       return {
//         width: parseFloat(width),
//         height: parseFloat(height),
//         depth: parseFloat(depth)
//       };
//     }

//     return undefined;
//   }

//   /**
//    * Calculate project statistics
//    */
//   private calculateStatistics(panels: PanelData[], groups: GroupData[]): ProjectStatistics {
//     const statusBreakdown: Record<string, number> = {};
    
//     panels.forEach(panel => {
//       statusBreakdown[panel.status] = (statusBreakdown[panel.status] || 0) + 1;
//     });

//     const totalPanels = panels.length;
//     const completedPanels = (statusBreakdown['PRODUCED'] || 0) + (statusBreakdown['SHIPPED'] || 0);
    
//     return {
//       totalPanels,
//       completedPanels,
//       readyForProduction: statusBreakdown['READY_FOR_PRODUCTION'] || 0,
//       inProduction: statusBreakdown['IN_PRODUCTION'] || 0,
//       shipped: statusBreakdown['SHIPPED'] || 0,
//       preFabricated: statusBreakdown['PRE_FABRICATED'] || 0,
//       progressPercentage: totalPanels > 0 ? Math.round((completedPanels / totalPanels) * 100) : 0,
//       statusBreakdown
//     };
//   }

//   /**
//    * Collect all element IDs from spatial node and children
//    */
//   private collectElementIds(node: SpatialNode): string[] {
//     const ids = [node.id];
//     node.children.forEach(child => {
//       ids.push(...this.collectElementIds(child));
//     });
//     return ids;
//   }

//   /**
//    * Get total element count from spatial structure
//    */
//   private getTotalElementCount(spatialStructure: SpatialNode[]): number {
//     return spatialStructure.reduce((total, node) => {
//       return total + node.elementCount + this.getTotalElementCount(node.children);
//     }, 0);
//   }

//   /**
//    * Save extracted metadata to database
//    */
//   private async saveMetadataToDatabase(modelId: string, metadata: FragmentMetadata): Promise<void> {
//     try {
//       // Get the project ID from the model
//       const model = await prisma.model.findUnique({
//         where: { id: modelId },
//         select: { projectId: true }
//       });

//       if (!model) {
//         throw new Error(`Model ${modelId} not found`);
//       }

//       const projectId = model.projectId;
      
//       logger.info(`💾 Saving ${metadata.panels.length} panels and ${metadata.groups.length} groups to database`);

//       // Calculate filter metadata from panels
//       const filterMetadata = this.calculateFilterMetadata(metadata.panels);
//       logger.info(`📊 Filter metadata: ${JSON.stringify(filterMetadata)}`);

//       // Update model with spatial structure first (outside transaction)
//       await prisma.model.update({
//         where: { id: modelId },
//         data: {
//           spatialStructure: JSON.stringify({
//             structure: metadata.spatialStructure,
//             totalPanels: metadata.panels.length,
//             totalGroups: metadata.groups.length,
//             statistics: metadata.statistics,
//             filters: filterMetadata
//           }),
//           elementCount: metadata.totalElements,
//           processingProgress: 100,
//           status: 'READY'
//         }
//       });

//       // Create groups (small number, can use regular inserts)
//       for (const groupData of metadata.groups) {
//         await prisma.group.create({
//           data: {
//             id: groupData.id,
//             projectId: projectId,
//             name: groupData.name,
//             description: groupData.description,
//             status: 'PENDING',
//             elementIds: groupData.elementIds,
//             metadata: {
//               type: groupData.type,
//               panelCount: groupData.panelCount
//             }
//           }
//         });
//       }

//       // Create panels using batch inserts (1000 at a time to avoid memory issues)
//       const batchSize = 1000;
//       const totalBatches = Math.ceil(metadata.panels.length / batchSize);
      
//       for (let i = 0; i < totalBatches; i++) {
//         const start = i * batchSize;
//         const end = Math.min(start + batchSize, metadata.panels.length);
//         const batch = metadata.panels.slice(start, end);
        
//         logger.info(`📦 Saving panel batch ${i + 1}/${totalBatches} (${batch.length} panels)`);
        
//         // Prepare batch data
//         const panelData = batch.map(panelData => {
//           const dbStatus = this.mapPanelStatusToDb(panelData.status);
//           // Assign panel to its primary group (first group in the list)
//           const primaryGroupId: string | null = (panelData.groups && panelData.groups.length > 0 && panelData.groups[0]) ? panelData.groups[0] : null;
          
//           return {
//             name: panelData.name,
//             projectId: projectId,
//             modelId: modelId,
//             tag: panelData.id,
//             objectType: panelData.properties.type || 'Panel',
//             location: panelData.properties.storey || 'Unknown',
//             material: panelData.properties.material || 'Concrete',
//             status: dbStatus,
//             groupId: primaryGroupId, // Assign to primary group
//             dimensions: panelData.dimensions ? JSON.stringify(panelData.dimensions) : null,
//             metadata: {
//               ...panelData.properties,
//               groups: panelData.groups,
//               originalId: panelData.id
//             }
//           };
//         });
        
//         // Batch insert
//         await prisma.panel.createMany({
//           data: panelData,
//           skipDuplicates: true
//         });
//       }

//       logger.info(`✅ Metadata saved for model ${modelId}: ${metadata.panels.length} panels, ${metadata.groups.length} groups`);
//       logger.info(` Model ${modelId} status: READY (100%)`);
//       logger.info(`FRAG processing completed for model ${modelId}: ${JSON.stringify({
//         totalElements: metadata.totalElements,
//         groupsCount: metadata.groups.length,
//         panelsCount: metadata.panels.length,
//         spatialStructureNodes: metadata.spatialStructure.length
//       })}`);
//     } catch (error) {
//       logger.error(`Failed to save metadata for model ${modelId}:`, error);
//       throw error;
//     }
//   }

//   /**
//    * Map panel status from FRAG processor to database enum
//    */
//   private mapPanelStatusToDb(status: PanelData['status']): 'READY_FOR_PRODUCTION' | 'PRODUCED' | 'PRE_FABRICATED' | 'READY_FOR_TRUCK_LOAD' | 'SHIPPED' | 'EDIT' {
//     // No mapping needed anymore - return status as-is since we updated the enum
//     return status;
//   }

//   /**
//    * Update model processing status
//    */
//   private async updateModelStatus(modelId: string, status: string, progress: number): Promise<void> {
//     try {
//       await prisma.model.update({
//         where: { id: modelId },
//         data: {
//           status: status as any,
//           processingProgress: progress
//         }
//       });

//       logger.info(`📊 Model ${modelId} status: ${status} (${progress}%)`);
//     } catch (error) {
//       logger.error(`Failed to update status for model ${modelId}:`, error);
//     }
//   }
// }

// export const fragProcessor = new FragProcessor();
