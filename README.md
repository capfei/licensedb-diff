# LicenseDB License diff browser extension (not official)

The LicenseDB License Diff browser extension diffs selected text to find the closest license or 
exception text matches against AboutCode's [ScanCode LicenseDB list](https://scancode-licensedb.aboutcode.org/index.html) and the [SPDX License List](https://spdx.org/licenses/).
These lists include identifiers, license text and exception text from AboutCode, SPDX and OSI.

This project was created to help me with comparing licenses easily from a browser. This is not an
official extension.

## Installation

The extension is available for
[Chrome](https://chromewebstore.google.com/detail/licensedb-diff/nlbgoabjahcideocgmnipmeabicnpejf)
and [Microsoft Edge](https://microsoftedge.microsoft.com/addons/detail/licensedb-diff/phmkmmgkfediamaidpmmdgnbbglchadl).

## Using the extension

To run the diff, select text on a web page and click on the extension icon. You will have the option
to compare against licenses, exceptions or both. You can also select which source you want results from (SPDX, ScanCode or both) and to include/exclude deprecated licenses and exceptions. Once the comparisons have
completed, it will return the top 10 results (this can be changed in the extension options). You can
select each result from the dropdown to see the differences, click the link to go to the license text source and copy the license identifier by clicking
on the copy button.

When using both sources, the results will be sorted by highest to lowest match score or you can select "Group by source"  in the "Results grouping" dropdown to group results by SPDX and ScanCode.

This has only been tested on web pages and may not work correctly for documents being viewed in a browser.

## Options

In the extension options, you can set the maximum number of results to return, set the minimum match threshold, manually refresh the license database, reset the database for a complete rebuild and choose the theme (light or dark).

