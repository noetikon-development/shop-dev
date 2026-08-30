import "server-only";
import { prisma } from "@/lib/prisma";

export type PickerAsset = {
  id: string;
  url: string;
  filename: string;
  folder: string;
  alt: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
};

/** Recent images for the media picker (settings + content-block forms). */
export async function getPickerAssets(): Promise<PickerAsset[]> {
  const rows = await prisma.mediaAsset.findMany({
    where: { mimeType: { startsWith: "image/" } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true,
      url: true,
      filename: true,
      folder: true,
      alt: true,
      mimeType: true,
      sizeBytes: true,
      width: true,
      height: true,
    },
  });
  return rows;
}
