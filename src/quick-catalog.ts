export const QUICK_TOOLS = [
  ['video-converter', 'Video converter', 'Convert a video or copy compatible streams to a new container.'],
  ['video-compressor', 'Video compressor', 'Compress a video to a quality or file-size target.'],
  ['video-trimmer', 'Video trimmer', 'Set an exact range or copy it at the nearest keyframe.'],
  ['extract-audio', 'Extract audio', 'Save an audio track from a video.'],
  ['rotate-video', 'Rotate and flip', 'Correct orientation or mirror the picture.'],
  ['change-speed', 'Change video speed', 'Adjust video speed with synchronized audio or mute.'],
  ['reverse-video', 'Reverse video', 'Reverse a selected part of the video.'],
  ['extract-frames', 'Extract frames', 'Save still images from a video individually or as a ZIP.'],
  ['video-to-gif', 'Video to GIF', 'Turn part of a video into a looping animation.'],
  ['video-watermark', 'Video watermark', 'Place text or a logo over a video.'],
  ['video-collage', 'Video collage', 'Arrange several playing videos on one canvas.'],
  ['image-converter', 'Image converter', 'Resize an image and change its format.'],
  ['image-watermark', 'Image watermark', 'Place text or a logo over an image.'],
  ['grid-maker', 'Drawing grid', 'Add a labeled grid for drawing from a reference.'],
  ['background-remover', 'Refine background', 'Remove a background color or refine an AI cutout with brushes.'],
  ['image-collage', 'Image collage', 'Crop and arrange several images on one canvas.'],
] as const;

export type QuickTool = typeof QUICK_TOOLS[number][0];

export function quickTool(id: string | null | undefined): QuickTool {
  return QUICK_TOOLS.find(([key]) => key === id)?.[0] ?? QUICK_TOOLS[0][0];
}

export function isImageTool(id: QuickTool): boolean {
  return ['image-converter', 'image-watermark', 'grid-maker', 'background-remover', 'image-collage'].includes(id);
}
