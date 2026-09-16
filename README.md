# LicenseDB License diff browser extension (not official)

The LicenseDB License Diff browser extension diffs selected text to find the closest license or 
exception text matches against AboutCode's [ScanCode LicenseDB list](https://scancode-licensedb.aboutcode.org/index.html) and the [SPDX License List](https://spdx.org/licenses/).
These lists include identifiers, license text and exception text from AboutCode, SPDX and OSI.

This project was created to help me with comparing licenses easily from a browser. This is not an
official extension.

## Installation

The extension is available at:
- [Chrome Web Store](https://chromewebstore.google.com/detail/licensedb-diff/nlbgoabjahcideocgmnipmeabicnpejf)
- [Firefox Browser Add-ons](https://addons.mozilla.org/en-US/firefox/addon/licensedb-license-diff/)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/licensedb-diff/phmkmmgkfediamaidpmmdgnbbglchadl)

## Using the extension

To run the diff, select text on a web page and click on the extension icon. You will have the option
to compare against licenses, exceptions or both. You can also select which source you want results from (SPDX, ScanCode or both) and to include/exclude deprecated licenses and exceptions. Once the comparisons have
completed, it will return the top 10 results (this can be changed in the extension options but can may cause performance issues if set too high).

Each result is listed with its identifier, match percentage and source. Selecting a result shows:

- A link to the license text source and a copy button for the license identifier.
- Coverage: how much of the reference license appears in your selection. 100% means the whole license is present, even if your selection also contains other text.
- Word overlap: identical words as a share of all words across both texts. This sits below coverage when your selection carries text beyond the license itself.
- A "Details" toggle revealing the ranking score and the measures behind it (containment, cosine, token Levenshtein). Results that match the license template exactly, ignoring variable fields, are flagged as a template match.
- A word-level diff, with a summary of how many words are unchanged, how many appear only in your selection and how many appear only in the reference license.

The diff view has a toolbar for working through the differences:

- Next / previous change buttons, with a counter showing your position.
- "Only changes" collapses long unchanged passages so you only see what differs.
- "Copy diff" copies the diff as plain text, with `[-removed-]` and `{+added+}` markers.
- "Copy reference" copies the full reference license text.

When using both sources, the results will be sorted by highest to lowest match score or you can select "Group by source"  in the "Results grouping" dropdown to group results by SPDX and ScanCode.

This has only been tested on web pages and may not work correctly for documents being viewed in a browser.

## Options

In the extension options, you can set the maximum number of results to return, set the minimum match threshold, manually refresh the license database, reset the database for a complete rebuild and choose the theme (light or dark).

