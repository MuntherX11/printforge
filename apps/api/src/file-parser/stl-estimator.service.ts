import { Injectable, BadRequestException } from '@nestjs/common';

export interface StlAnalysis {
  triangleCount: number;
  volumeCm3: number;
  surfaceAreaCm2: number;
  boundingBox: { x: number; y: number; z: number }; // mm
  estimatedGrams: number; // at given density + infill
  estimatedMinutes: number; // rough print time estimate
}

@Injectable()
export class StlEstimatorService {
  /**
   * Parse a binary STL file and estimate volume, weight, and print time.
   * Binary STL format:
   *   80 bytes header
   *   4 bytes uint32 triangle count
   *   per triangle: 12 floats (normal + 3 vertices) + 2 bytes attribute
   */
  analyze(buffer: Buffer, density = 1.24, infillPercent = 20): StlAnalysis {
    if (buffer.length < 84) {
      throw new BadRequestException('File too small to be a valid STL');
    }

    // Check if ASCII STL (starts with "solid")
    const headerStr = buffer.subarray(0, 5).toString('ascii');
    if (headerStr === 'solid') {
      // Could be ASCII STL — check if it actually contains "facet"
      const first200 = buffer.subarray(0, 200).toString('ascii');
      if (first200.includes('facet')) {
        throw new BadRequestException('ASCII STL not supported. Please export as binary STL.');
      }
    }

    const triangleCount = buffer.readUInt32LE(80);
    const expectedSize = 84 + triangleCount * 50;

    if (buffer.length < expectedSize) {
      throw new BadRequestException(`STL file truncated: expected ${expectedSize} bytes, got ${buffer.length}`);
    }

    let totalVolume = 0;
    let totalSurfaceArea = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    let offset = 84;
    for (let i = 0; i < triangleCount; i++) {
      // Skip normal (3 floats = 12 bytes)
      offset += 12;

      // Read 3 vertices
      const v1x = buffer.readFloatLE(offset); offset += 4;
      const v1y = buffer.readFloatLE(offset); offset += 4;
      const v1z = buffer.readFloatLE(offset); offset += 4;
      const v2x = buffer.readFloatLE(offset); offset += 4;
      const v2y = buffer.readFloatLE(offset); offset += 4;
      const v2z = buffer.readFloatLE(offset); offset += 4;
      const v3x = buffer.readFloatLE(offset); offset += 4;
      const v3y = buffer.readFloatLE(offset); offset += 4;
      const v3z = buffer.readFloatLE(offset); offset += 4;

      // Skip attribute byte count
      offset += 2;

      // Bounding box
      minX = Math.min(minX, v1x, v2x, v3x);
      minY = Math.min(minY, v1y, v2y, v3y);
      minZ = Math.min(minZ, v1z, v2z, v3z);
      maxX = Math.max(maxX, v1x, v2x, v3x);
      maxY = Math.max(maxY, v1y, v2y, v3y);
      maxZ = Math.max(maxZ, v1z, v2z, v3z);

      // Signed volume via tetrahedron method (vertex to origin)
      // V = (1/6) * |v1 . (v2 x v3)|
      totalVolume += this.signedTriangleVolume(v1x, v1y, v1z, v2x, v2y, v2z, v3x, v3y, v3z);

      // Surface area of triangle
      totalSurfaceArea += this.triangleArea(v1x, v1y, v1z, v2x, v2y, v2z, v3x, v3y, v3z);
    }

    // Volume is in mm^3, convert to cm^3
    const volumeMm3 = Math.abs(totalVolume);
    const volumeCm3 = volumeMm3 / 1000;
    const surfaceAreaCm2 = totalSurfaceArea / 100;

    const boundingBox = {
      x: maxX - minX,
      y: maxY - minY,
      z: maxZ - minZ,
    };

    // Estimate weight: shell is ~100% fill, interior is infill%
    // Rough model: total_material = shell_volume * density + interior_volume * (infill/100) * density
    // Simplified: effectiveVolume = volume * (shellFraction + interiorFraction * infill/100)
    // For typical prints, use a simplified model:
    // wall thickness ~1.2mm, so shell is about surfaceArea * wallThickness
    const wallThickness = 1.2; // mm
    const shellVolumeMm3 = Math.min(totalSurfaceArea * wallThickness, volumeMm3);
    const interiorVolumeMm3 = Math.max(0, volumeMm3 - shellVolumeMm3);
    const effectiveVolumeMm3 = shellVolumeMm3 + interiorVolumeMm3 * (infillPercent / 100);
    const effectiveVolumeCm3 = effectiveVolumeMm3 / 1000;
    const estimatedGrams = Math.round(effectiveVolumeCm3 * density * 100) / 100;

    // Rough print time estimate: ~5 cm^3/hour for FDM at typical speeds
    // This is a very rough estimate. Real time depends on geometry, speed, etc.
    const cm3PerHour = 5;
    const estimatedMinutes = Math.round((effectiveVolumeCm3 / cm3PerHour) * 60);

    return {
      triangleCount,
      volumeCm3: Math.round(volumeCm3 * 100) / 100,
      surfaceAreaCm2: Math.round(surfaceAreaCm2 * 100) / 100,
      boundingBox: {
        x: Math.round(boundingBox.x * 10) / 10,
        y: Math.round(boundingBox.y * 10) / 10,
        z: Math.round(boundingBox.z * 10) / 10,
      },
      estimatedGrams,
      estimatedMinutes,
    };
  }

  /**
   * Signed volume of tetrahedron formed by triangle and origin.
   * Using the formula: V = (1/6) * (v1 . (v2 x v3))
   */
  private signedTriangleVolume(
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
    v3x: number, v3y: number, v3z: number,
  ): number {
    // Cross product v2 x v3
    const cx = v2y * v3z - v2z * v3y;
    const cy = v2z * v3x - v2x * v3z;
    const cz = v2x * v3y - v2y * v3x;
    // Dot product v1 . cross
    return (v1x * cx + v1y * cy + v1z * cz) / 6;
  }

  /**
   * Area of a triangle given 3 vertices.
   */
  private triangleArea(
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
    v3x: number, v3y: number, v3z: number,
  ): number {
    // Edge vectors
    const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
    const e2x = v3x - v1x, e2y = v3y - v1y, e2z = v3z - v1z;
    // Cross product
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
}
