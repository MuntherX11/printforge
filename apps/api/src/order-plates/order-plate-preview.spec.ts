import { parsePlateOutlines, plateOutlinesOf } from '../file-parser/plate-footprint';
import { bedOf, exactPreview, inputOfLabel, simplifyPolygon, sketchPreview } from './order-plate-preview';

/** The top-down drawing of a plate: exact from the sliced file, a sketch before. */

describe('bedOf', () => {
  it('reads the size and the front-left corner of printable_area', () => {
    expect(bedOf(['0x0', '220x0', '220x220', '0x220'])).toEqual({ x: 220, y: 220, originX: 0, originY: 0 });
    expect(bedOf(['-5x-10', '255x-10', '255x250', '-5x250'])).toEqual({ x: 260, y: 260, originX: -5, originY: -10 });
  });

  it('null for anything that is not a bed', () => {
    for (const bad of [null, undefined, [], ['0x0'], ['0x0', 'wide'], ['0x0', '0x0'], '0x0,220x220', { x: 1 }]) expect(bedOf(bad)).toBeNull();
  });
});

describe('inputOfLabel', () => {
  it('finds the input behind any path prefix, with or without a copy number', () => {
    expect(inputOfLabel('in0_0.stl')).toBe(0);
    expect(inputOfLabel('in3_1.stl_12')).toBe(3);
    expect(inputOfLabel('_tmp_slice_ab12_in2_0.stl_id_4_copy_0')).toBe(2);
    expect(inputOfLabel('C__scratch_job-7_in11_0.stl_2')).toBe(11);
  });

  it('never reads in1 out of in11, nor a model that only looks alike', () => {
    expect(inputOfLabel('x_in11_0.stl_1')).toBe(11);
    expect(inputOfLabel('main1_0.stl')).toBeNull();
    expect(inputOfLabel('in1_0.stlx')).toBeNull();
    expect(inputOfLabel('fish.stl_3')).toBeNull();
    expect(inputOfLabel('')).toBeNull();
  });
});

describe('simplifyPolygon', () => {
  it('keeps an outline of up to 64 points as it is and thins a longer one evenly', () => {
    const square: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(simplifyPolygon(square)).toEqual(square);
    const circle: Array<[number, number]> = Array.from({ length: 400 }, (_, i) => [Math.cos(i), Math.sin(i)]);
    const thin = simplifyPolygon(circle);
    expect(thin).toHaveLength(64);
    expect(thin[0]).toEqual(circle[0]);
    expect(thin.every((p) => circle.some((c) => c[0] === p[0] && c[1] === p[1]))).toBe(true);
  });
});

describe('exactPreview', () => {
  const text = [
    'EXCLUDE_OBJECT_DEFINE NAME=_s_in0_0.stl_1 CENTER=15,15 POLYGON=[[10,10],[20,10],[20,20],[10,20]]',
    'EXCLUDE_OBJECT_DEFINE NAME=_s_in0_0.stl_2 CENTER=35,15 POLYGON=[[30,10],[40,10],[40,20],[30,20]]',
    'EXCLUDE_OBJECT_DEFINE NAME=_s_in1_0.stl CENTER=60,60 POLYGON=[[50,50],[70,50],[70,70],[50,70]]',
    'EXCLUDE_OBJECT_DEFINE NAME=wipe_tower CENTER=200,200 POLYGON=[[190,190],[210,190],[210,210],[190,210]]',
    'EXCLUDE_OBJECT_DEFINE NAME=stray CENTER=1,1 POLYGON=[[0,0],[1,0],[1,1]]',
  ].join('\n');

  it('gives every object to the plan row of its input; an unknown label has no row; the purge tower is not drawn', () => {
    const p = exactPreview(bedOf(['0x0', '220x0', '220x220', '0x220']), parsePlateOutlines(text), ['row-a', 'row-b'])!;
    expect(p).toMatchObject({ bed: { x: 220, y: 220 }, exact: true, overflow: 0 });
    expect(p.objects.map((o) => o.rowKey)).toEqual(['row-a', 'row-a', 'row-b', null]);
    expect(p.objects[2].polygon).toEqual([[50, 50], [70, 50], [70, 70], [50, 70]]);
  });

  it('a plate with one part gives it every object, whatever the labels are', () => {
    const p = exactPreview(bedOf(['0x0', '220x0', '220x220', '0x220']), parsePlateOutlines(text), ['only'])!;
    expect(p.objects.every((o) => o.rowKey === 'only')).toBe(true);
  });

  it('is drawn from the bed\'s corner, and null without a bed or without objects', () => {
    const bed = bedOf(['-10x-10', '210x-10', '210x210', '-10x210']);
    expect(exactPreview(bed, parsePlateOutlines(text), ['a', 'b'])!.objects[0].polygon[0]).toEqual([20, 20]);
    expect(exactPreview(null, parsePlateOutlines(text), ['a'])).toBeNull();
    expect(exactPreview(bed, [], ['a'])).toBeNull();
  });

  it('reads the outlines and the bed out of a whole file, stopping at the first object\'s moves', () => {
    const file = Buffer.from(`; thumbnail\n${text}\nEXCLUDE_OBJECT_START NAME=x\nEXCLUDE_OBJECT_DEFINE NAME=late POLYGON=[[0,0],[1,0],[1,1]]\nG1 X1\n; printable_area = 0x0,260x0,260x260,0x260\n`);
    const read = plateOutlinesOf(file);
    expect(read.outlines.map((o) => o.name)).toEqual(['_s_in0_0.stl_1', '_s_in0_0.stl_2', '_s_in1_0.stl', 'stray']);
    expect(read.printableArea).toEqual(['0x0', '260x0', '260x260', '0x260']);
  });
});

describe('sketchPreview', () => {
  const bed = { x: 100, y: 100 };

  it('lays the units out in rows with a 5 mm gap, in the order given', () => {
    const p = sketchPreview(bed, [{ rowKey: 'a', units: 3, footprint: { x: 40, y: 20 } }, { rowKey: 'b', units: 1, footprint: { x: 10, y: 10 } }])!;
    expect(p).toMatchObject({ bed, exact: false, overflow: 0 });
    expect(p.objects.map((o) => [o.rowKey, o.polygon[0]])).toEqual([['a', [0, 0]], ['a', [45, 0]], ['a', [0, 25]], ['b', [45, 25]]]);
    expect(p.objects[0].polygon).toEqual([[0, 0], [40, 0], [40, 20], [0, 20]]);
  });

  it('counts what finds no room as overflow', () => {
    const p = sketchPreview(bed, [{ rowKey: 'a', units: 7, footprint: { x: 45, y: 45 } }])!;
    expect(p.objects).toHaveLength(4);
    expect(p.overflow).toBe(3);
  });

  it('turns a unit that only fits the other way; one that fits neither way is all overflow', () => {
    const turned = sketchPreview({ x: 50, y: 120 }, [{ rowKey: 'a', units: 1, footprint: { x: 100, y: 30 } }])!;
    expect(turned.objects[0].polygon[2]).toEqual([30, 100]);
    const big = sketchPreview(bed, [{ rowKey: 'a', units: 2, footprint: { x: 150, y: 150 } }])!;
    expect(big).toMatchObject({ objects: [], overflow: 2 });
  });

  it('draws a part of unknown size as 40 x 40 mm beside known ones, and nothing when no size is known or there is no bed', () => {
    const p = sketchPreview(bed, [{ rowKey: 'a', units: 1, footprint: { x: 10, y: 10 } }, { rowKey: 'b', units: 1, footprint: null }])!;
    expect(p.objects[1].polygon[2]).toEqual([55, 40]);
    expect(sketchPreview(bed, [{ rowKey: 'b', units: 1, footprint: null }])).toBeNull();
    expect(sketchPreview(null, [{ rowKey: 'a', units: 1, footprint: { x: 10, y: 10 } }])).toBeNull();
  });
});
