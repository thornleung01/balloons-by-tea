/*
  Product catalog — edit this file to add, remove, rename, or re-price items.
  No build step required: just save and refresh the browser.

  Each item needs:
    id          unique string (keep stable once published — it's used as the cart key)
    name        display name
    price       number, in whole currency units (e.g. 58 = $58)
    description short line shown on the card
    colors      2-3 hex colors used to tint the placeholder balloon illustration
                (swap illustrations for real photos — see README "Using real photos")

  Photos (optional — without either, the card shows the placeholder graphic):
    image       a single photo path/URL, e.g. "images/sanrio-bouquet.png"
    images      an array of photo paths/URLs for an item with more than one
                picture, e.g. ["images/item-1.png", "images/item-2.png"] —
                the first one is the card thumbnail, and clicking it opens
                all of them in a swipeable lightbox. Use `images` instead of
                `image` once an item has more than one photo; only one of
                the two is needed.
*/

const COLLECTIONS = {
  "anniversary": {
    title: "Anniversary",
    tagline: "Refined installations for anniversaries and romantic celebrations.",
    items: [
      { id: "anniv-ivory-arch", name: "Ivory Romance Arch", price: 320, description: "Full-size organic arch in ivory, cream and gold for celebrations.", colors: ["#F3EEE6", "#D4A94A", "#FFFFFF"] },
      { id: "anniv-champagne-toast", name: "Champagne Toast Bouquet", price: 85, description: "Entrance bouquet in champagne and gold tones for a toast-worthy night.", colors: ["#D4A94A", "#F3EEE6", "#A16207"] },
      { id: "anniv-blush-gold-set", name: "Blush & Gold Celebration Set", price: 240, description: "Pair of elegant clusters in blush, ivory and gold.", colors: ["#E7C5C1", "#D4A94A", "#F3EEE6"] },
      { id: "anniv-golden-years", name: "Golden Years Cluster", price: 95, description: "Hand-held cluster perfect for marking another year together.", colors: ["#FFFFFF", "#D4A94A", "#E7C5C1"] },
      { id: "anniv-sweetheart", name: "Sweetheart Table Accent", price: 70, description: "Low, elegant accent sized for an intimate anniversary dinner.", colors: ["#F3EEE6", "#E7C5C1", "#A16207"] },
      { id: "anniv-grand-entrance", name: "Grand Entrance Arch", price: 380, description: "Statement double-arch for venue entrances and anniversary parties.", colors: ["#FFFFFF", "#D4A94A", "#9CAF88"] }
    ]
  },
  "birthday": {
    title: "Birthday",
    tagline: "Milestone birthdays and adult celebrations, styled with a touch of luxury.",
    items: [
      { id: "bday-golden-hour", name: "Golden Hour Bouquet", price: 58, description: "Champagne, cream & gold latex bouquet with trailing ribbon.", colors: ["#D4A94A", "#F3EEE6", "#A16207"] },
      { id: "bday-midnight", name: "Midnight Confetti Bash", price: 68, description: "Charcoal and gold bouquet with a confetti sparkle for a birthday night out.", colors: ["#1C1917", "#A16207", "#57534E"] },
      { id: "bday-garden-party", name: "Garden Party", price: 64, description: "Sage, cream and blush balloons styled with dried florals.", colors: ["#9CAF88", "#F3EEE6", "#E7C5C1"] },
      { id: "bday-sanrio-bouquet", name: "Sanrio Bouquet", price: 70, description: "Sanrio character foil balloon paired with a playful mixed-latex bouquet.", colors: ["#F8C4C4", "#B9DCF3", "#FFD66B"], image: "images/sanrio-bouquet.webp" }
    ]
  },
  "kids": {
    title: "Kids",
    tagline: "Playful balloon styling for kids' birthdays and parties.",
    items: [
      { id: "kids-confetti-pop", name: "Confetti Pop", price: 62, description: "Cream and gold balloons with a hand-scattered confetti accent.", colors: ["#F3EEE6", "#D4A94A", "#1C1917"] },
      { id: "kids-luxe-number", name: "Little Luxe Number", price: 75, description: "Oversized number balloon framed by an organic cream cluster.", colors: ["#1C1917", "#F3EEE6", "#D4A94A"] },
      { id: "kids-candyfloss", name: "Candyfloss Dream", price: 58, description: "Soft blush and cream balloons for a gentle celebration palette.", colors: ["#E7C5C1", "#F3EEE6", "#D4A94A"] }
    ]
  },
  "other-occasions": {
    title: "Other Occasions",
    tagline: "Baby showers, corporate events and everything else worth celebrating.",
    items: [
      { id: "baby-oh-baby", name: "Oh Baby Bouquet", price: 60, description: "Neutral sage and cream bouquet suited to any gender reveal.", colors: ["#9CAF88", "#F3EEE6", "#D4A94A"] },
      { id: "baby-gender-reveal", name: "Gender Reveal Burst", price: 90, description: "Confetti-filled reveal balloon in a cream shell, pink or blue inside.", colors: ["#E7C5C1", "#AFC9E0", "#F3EEE6"] },
      { id: "baby-little-cloud", name: "Little Cloud Set", price: 58, description: "Pastel blue and cream cluster with a soft cloud motif.", colors: ["#AFC9E0", "#F3EEE6", "#FFFFFF"] },
      { id: "baby-welcome-arch", name: "Welcome Little One Arch", price: 180, description: "Petite arch for the welcome table or photo backdrop.", colors: ["#F3EEE6", "#9CAF88", "#E7C5C1"] },
      { id: "baby-storybook", name: "Storybook Bouquet", price: 64, description: "Sage, blush and cream styled with a storybook ribbon trail.", colors: ["#9CAF88", "#E7C5C1", "#F3EEE6"] },
      { id: "baby-sprinkle", name: "Sprinkle Shower Set", price: 70, description: "Playful cluster sized for a sprinkle-style shower.", colors: ["#D4A94A", "#AFC9E0", "#F3EEE6"] },
      { id: "corp-brand-backdrop", name: "Grand Debut Backdrop", price: 260, description: "Full organic backdrop, dressed up in your brand's colors to celebrate big.", colors: ["#1C1917", "#D4A94A", "#57534E"] },
      { id: "corp-grand-opening", name: "Grand Opening Arch", price: 300, description: "Statement arch for storefront or venue grand openings.", colors: ["#A16207", "#F3EEE6", "#1C1917"] },
      { id: "corp-exec-welcome", name: "Warm Welcome Bouquet", price: 75, description: "A friendly bouquet to greet guests at reception desks and welcome tables.", colors: ["#57534E", "#F3EEE6", "#D4A94A"] },
      { id: "corp-holiday-soiree", name: "Holiday Sparkle Set", price: 120, description: "Festive cluster in seasonal colors for holiday parties big and small.", colors: ["#1C1917", "#A16207", "#9CAF88"] },
      { id: "corp-gala-centerpiece", name: "Celebration Centerpiece Trio", price: 95, description: "Set of three low centerpieces to dress up any celebration table.", colors: ["#D4A94A", "#1C1917", "#F3EEE6"] },
      { id: "corp-conference-columns", name: "Grand Welcome Columns", price: 210, description: "A cheerful pair of standing columns to frame your conference entrance.", colors: ["#57534E", "#D4A94A", "#F3EEE6"] }
    ]
  }
};
