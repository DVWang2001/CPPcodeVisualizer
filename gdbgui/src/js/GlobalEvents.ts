/**
 * Setup global DOM events
 */

import constants from "./constants";
import GdbApi from "./GdbApi";
import { store } from "statorgfc";

const GlobalEvents = {
  init: function () {
    window.onkeydown = function (e: any) {
      if (e.keyCode === constants.ENTER_BUTTON_NUM && e.target.nodeName !== "TEXTAREA") {
        // when pressing enter in an input, don't redirect entire page!
        e.preventDefault();
      }
    };
    $("body").on("keydown", GlobalEvents.body_keydown);
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'tooltip' does not exist on type 'JQuery<... Remove this comment to see the full error message
    $('[data-toggle="tooltip"]').tooltip();

    window.onbeforeunload = () =>
      "text here makes dialog appear when exiting. Set function to back to null for nomal behavior.";
  },
  /**
   * keyboard shortcuts to interact with gdb.
   * enabled only when key is depressed on a target that is NOT an input.
   */
  body_keydown: function (e: any) {
    // Keyboard shortcuts removed
  }
};

export default GlobalEvents;
