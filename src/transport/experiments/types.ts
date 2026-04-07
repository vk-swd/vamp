import { z } from 'zod';

export const AssetKind = z.enum(['style', 'script']);
export type AssetKind = z.infer<typeof AssetKind>;

export const AssetMessage = z.object({
    kind: AssetKind,
    data: z.base64(),
});
export type AssetMessage = z.infer<typeof AssetMessage>;
