export const demoVideo = {
  src: "/demo/launch.mp4",
  poster: "/demo/launch.webp",
};

export const demoWorkspace = {
  sign_in: true,
  signed_in: true,
  profiles: [
    {
      id: "demo-studio",
      name: "Distro Studio",
      default: true,
      accounts: [
        { account_id: "demo-tiktok", platform: "tiktok", username: "distro.demo", active: true },
        { account_id: "demo-instagram", platform: "instagram", username: "distro.demo", active: true },
        { account_id: "demo-youtube", platform: "youtube", username: "distro.demo", active: false },
      ],
    },
  ],
  api_keys: [
    { id: "demo-agent", name: "Studio agent", ends_with: "demo", scopes: ["video", "publish"], created: "2026-11-03" },
  ],
};

export const demoPosts = [
  {
    id: "demo-launch", platform: "tiktok", username: "distro.demo", caption: "Meet Distro.",
    thumbnail: demoVideo.poster, published: "2026-11-10T12:00:00Z",
    views: 8400, likes: 602, comments: 28, shares: 41,
  },
  {
    id: "demo-idea", platform: "instagram", username: "distro.demo", caption: "From idea to video.",
    thumbnail: "/demo/idea.webp", published: "2026-11-08T12:00:00Z",
    views: 3900, likes: 286, comments: 13, shares: 17,
  },
  {
    id: "demo-share", platform: "tiktok", username: "distro.demo", caption: "Ready to share.",
    thumbnail: "/demo/share.webp", published: "2026-11-06T12:00:00Z",
    views: 2100, likes: 153, comments: 8, shares: 12,
  },
];
