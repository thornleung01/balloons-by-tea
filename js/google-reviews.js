/*
  Loads real reviews from your Google Business Profile via the Google Maps
  JavaScript API's Places library (not a raw REST call — Google's Places
  Details REST endpoint doesn't allow direct browser requests, so this goes
  through their client-side SDK instead, which is designed for this).

  NOTE: this has been built against Google's documented Places API (New)
  JS shape, but hasn't been tested against a live API key (I have no way
  to create a Google Cloud project myself). If Google's response fields
  don't quite match once you've got a real key wired up, check the current
  schema at:
  https://developers.google.com/maps/documentation/javascript/reference/place
  — the field names below (reviews[].text, .rating, .authorAttribution) are
  the ones to adjust first.

  Google limits Place Details to the 5 "most relevant" reviews regardless
  of which API you use — that's a Google-side limit, not something this
  code controls.
*/

let _googleMapsLoadingPromise = null;

function loadGoogleMapsScript() {
  if (_googleMapsLoadingPromise) return _googleMapsLoadingPromise;

  _googleMapsLoadingPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps && window.google.maps.places) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_PLACES_CONFIG.apiKey)}&libraries=places&v=weekly`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load the Google Maps script — check the API key and that it's allowed to load on this domain."));
    document.head.appendChild(script);
  });

  return _googleMapsLoadingPromise;
}

/* Returns an array shaped like the REVIEWS array in js/app.js
   ({name, rating, text, tag}), or null if unavailable for any reason —
   callers should fall back to the placeholder reviews when null. */
async function fetchGoogleReviews() {
  if (!isGooglePlacesConfigured()) return null;

  try {
    await loadGoogleMapsScript();
    const { Place } = await google.maps.importLibrary("places");
    const place = new Place({ id: GOOGLE_PLACES_CONFIG.placeId });
    await place.fetchFields({ fields: ["reviews", "displayName"] });

    if (!place.reviews || !place.reviews.length) {
      console.warn("[Balloons by Tea] Google Place has no reviews to show, using placeholder reviews instead.");
      return null;
    }

    const mapped = place.reviews
      .map((r) => {
        const text = (r.text && typeof r.text === "object" ? r.text.text : r.text) || "";
        const authorName = (r.authorAttribution && r.authorAttribution.displayName) || "Google user";
        const timeLabel = r.relativePublishTimeDescription ? ` · ${r.relativePublishTimeDescription}` : "";
        return {
          name: authorName,
          rating: r.rating || 5,
          text: text.trim(),
          tag: `Google review${timeLabel}`
        };
      })
      .filter((r) => r.text);

    return mapped.length ? mapped : null;
  } catch (err) {
    console.warn("[Balloons by Tea] Could not load Google reviews, showing placeholder reviews instead.", err);
    return null;
  }
}
