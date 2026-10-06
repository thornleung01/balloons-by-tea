/*
  Balloons by Tea — Google Reviews connection settings.

  Until both values below are filled in, the homepage review carousel just
  shows the placeholder reviews in js/app.js (REVIEWS array) — nothing
  breaks if this is never configured. Full setup walkthrough is in
  README.md, "Connect real Google Reviews".

  Unlike the Supabase anon key, this API key being visible in page source
  is the NORMAL, expected way Google's client-side Maps/Places products
  work — every site with an embedded Google Map ships its key this way.
  The protection is restricting the key (in Google Cloud Console) to only
  work when loaded from your domain, not keeping it secret.
*/
const GOOGLE_PLACES_CONFIG = {
  apiKey: "PASTE_YOUR_GOOGLE_MAPS_API_KEY_HERE",
  placeId: "PASTE_YOUR_GOOGLE_PLACE_ID_HERE"
};

function isGooglePlacesConfigured() {
  return (
    !!GOOGLE_PLACES_CONFIG.apiKey &&
    !GOOGLE_PLACES_CONFIG.apiKey.includes("PASTE_YOUR") &&
    !!GOOGLE_PLACES_CONFIG.placeId &&
    !GOOGLE_PLACES_CONFIG.placeId.includes("PASTE_YOUR")
  );
}
