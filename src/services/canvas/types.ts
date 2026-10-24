/** @fileoverview Analytical workspace presentation contracts. @module services/canvas/types */
import { z } from '@cyanheads/mcp-ts-core';
import type { ColumnSchema } from '@cyanheads/mcp-ts-core/canvas';
import {
  type BucketSummary,
  type CellSummary,
  type DatasetHandle,
  DatasetHandleSchema,
  JsonValueSchema,
  type NumericSummary,
  type ObservationRow,
  type ParameterMetadata,
  ParameterMetadataSchema,
} from '../power/types.js';

/** Narrow scientific envelope; presentation preserves every additional caller field. */
export type PresentableDataset = {
  rows: ObservationRow[];
  parameters: ParameterMetadata[];
};
/** Full row count and an optional pointer accompany the unmodified envelope. */
export type PresentedDataset<T extends PresentableDataset> = Omit<T, 'rows'> & {
  rows: ObservationRow[];
  rowCount: number;
  dataset: DatasetHandle | null;
  summaryDatasets?: { buckets: DatasetHandle; locations: DatasetHandle };
  summaryDataset?: DatasetHandle;
  summaryCount?: number;
};
/** Regional summaries before optional related-table staging. */
export type RegionalSummaryDataset = PresentableDataset & { summaries: CellSummary[] };
/** Complete comparison summaries before presentation; other scientific fields remain untouched. */
export type ComparisonDataset = PresentableDataset & {
  summaries: (Omit<BucketSummary, 'units'> & { units?: string | undefined })[];
  locations: { locationId: string; summaries: NumericSummary[] }[];
};
/** Full summary tables; summaryIndex preserves original array order across SQL pages. */
export const SummaryDatasetsSchema = z.object({
  buckets: DatasetHandleSchema.describe('Complete bucket summaries ordered by summaryIndex'),
  locations: DatasetHandleSchema.describe(
    'Complete per-location summaries with locationId, ordered by summaryIndex',
  ),
});
/** Native column schema plus scientific interpretation. */
export type ScientificColumn = ColumnSchema &
  Partial<Pick<ParameterMetadata, 'units' | 'valueKind'>>;
/** Provenance belongs to a single tenant, token and table. */
export const ProvenanceSchema = z.object({
  sourceTool: z.string().describe('Tool that staged this dataset'),
  envelope: z
    .record(z.string(), JsonValueSchema)
    .describe('Complete scientific envelope excluding observation rows'),
  createdAt: z.string().describe('Table creation timestamp'),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;
/** Real native types and current framework TTL annotations. */
export const DescribedTableSchema = z
  .object({
    table: z.string().describe('Canvas-local table name'),
    rowCount: z.number().describe('Exact staged row count'),
    expiresAt: z.string().nullable().describe('Current table expiry when independently tracked'),
    columns: z
      .array(
        z
          .object({
            name: z.string().describe('Column name'),
            type: z.string().describe('Actual native SQL type'),
            nullable: z.boolean().describe('Whether SQL NULL is permitted'),
            units: z.string().optional().describe('Source physical units'),
            valueKind: ParameterMetadataSchema.shape.valueKind
              .optional()
              .describe('Scientific value interpretation'),
          })
          .describe('One native column with its scientific interpretation'),
      )
      .describe('Actual schema with source interpretation'),
    provenance: ProvenanceSchema.describe('Original scientific provenance'),
  })
  .describe('One staged table and its source provenance');
export const DescribeResultSchema = z.object({
  canvas_id: z.string().describe('Explicit canvas capability token'),
  expiresAt: z.string().describe('Current canvas expiry'),
  tables: z.array(DescribedTableSchema).describe('Only tables within the supplied canvas'),
});
export const QueryResultSchema = z.object({
  canvas_id: z.string().describe('Explicit canvas capability token'),
  columns: z.array(z.string()).describe('Projected SQL column names'),
  rows: z.array(z.record(z.string(), JsonValueSchema)).describe('JSON-safe projected values'),
  rowCount: z.number().describe('Number of materialized rows; capped when truncated'),
  shownCount: z.number().describe('Rows shown in this response'),
  truncated: z.boolean().describe('Whether additional result rows exist'),
  countSemantics: z.enum(['exact', 'materialized_prefix']).describe('Meaning of rowCount'),
});
