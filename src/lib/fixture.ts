export const developmentFixture = {
  source: {
    fileName: "coastal-drive.mov",
    duration: "02:16",
  },
  samples: ["00:27", "01:08", "01:49"],
  candidates: [
    { artist: "Kali Uchis", title: "Moonlight", confidence: "High confidence" },
    { artist: "Khruangbin", title: "Friday Morning", confidence: "Possible match" },
  ],
} as const;
