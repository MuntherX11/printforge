import { IsArray, IsNumber, IsOptional, IsString, IsBoolean, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CustomerQuoteCostDto {
  @IsNumber()
  @Min(0)
  suggestedPrice!: number;

  @IsNumber()
  @Min(0)
  totalCost!: number;
}

export class CustomerQuotePlateDto {
  @IsNumber()
  plateIndex!: number;

  @IsString()
  name!: string;

  @IsNumber()
  @Min(0)
  printSeconds!: number;

  @IsNumber()
  @Min(0)
  weightGrams!: number;

  @IsOptional()
  @IsBoolean()
  isMultiColor?: boolean;

  @ValidateNested()
  @Type(() => CustomerQuoteCostDto)
  breakdown!: CustomerQuoteCostDto;
}

export class CustomerQuoteAnalysisDto {
  @IsString()
  fileName!: string;

  @IsString()
  fileType!: string;

  @IsOptional()
  @IsString()
  slicer?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estimatedTimeSeconds?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  filamentUsedGrams?: number;
}

export class CustomerQuoteRequestDto {
  // 3MF multi-plate path
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerQuotePlateDto)
  plates?: CustomerQuotePlateDto[];

  // Non-3MF single-file path
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerQuoteAnalysisDto)
  analysis?: CustomerQuoteAnalysisDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerQuoteCostDto)
  costEstimate?: CustomerQuoteCostDto;

  @IsOptional()
  @IsString()
  notes?: string;
}
