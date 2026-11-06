/**
 * Native helper for the cua_snap_click tool of the takeover indicator.
 *
 * The helper answers three questions about one point on the screen:
 *
 *   probe    - which window is on top at that point, and is it the window the
 *              caller meant to click? A covered point is refused.
 *   snapshot - a pixel hash of the target window and of the small area around
 *              the point, plus the UIA state of the element under the point.
 *   click    - a real mouse click at that point.
 *
 * The protocol is one JSON object per line: a request on stdin, an answer on
 * stdout. The process stays alive until it gets a shutdown request, so a click
 * does not pay the start-up cost of PowerShell every time.
 *
 * Every answer is pure ASCII: the JSON escapes everything outside the ASCII
 * range, so the caller never has to guess the encoding of the pipe.
 *
 * Everything here is C# 5 on purpose: the file is compiled by Add-Type in
 * Windows PowerShell 5.1, which has no Roslyn.
 */

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace DshSnapClick {
  /// <summary>Answers the requests of the cua_snap_click tool.</summary>
  public static class Host {
    private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
    private static int currentId;

    /// <summary>Read requests from stdin until the caller says stop.</summary>
    public static void Run() {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        line = line.Trim();
        if (line.Length == 0) continue;
        bool stop = false;
        string answer;
        try {
          var request = Serializer.Deserialize<Dictionary<string, object>>(line);
          answer = Dispatch(request, out stop);
        } catch (Exception error) {
          answer = ToJson(Failure("the request could not be read: " + error.Message));
        }
        Console.Out.WriteLine(answer);
        Console.Out.Flush();
        if (stop) break;
      }
    }
    private static string Dispatch(Dictionary<string, object> request, out bool stop) {
      stop = false;
      string command = Text(request, "command", "");
      currentId = Number(request, "id", 0);
      if (command == "shutdown") {
        stop = true;
        return ToJson(Success(command));
      }
      if (command == "ping") return ToJson(Success(command));
      if (command == "probe") return ToJson(Probe(request));
      if (command == "snapshot") return ToJson(Snapshot(request));
      if (command == "click") return ToJson(Click(request));
      if (command == "hover") return ToJson(Hover(request));
      if (command == "find") return ToJson(Find(request));
      if (command == "invoke") return ToJson(Invoke(request));
      var failure = Failure("unknown command: " + command);
      failure["command"] = command;
      return ToJson(failure);
    }

    /// <summary>Which window is on top at the point, and is it the wanted one?</summary>
    private static Dictionary<string, object> Probe(Dictionary<string, object> request) {
      int x = Number(request, "x", 0);
      int y = Number(request, "y", 0);
      string windowId = Text(request, "windowId", "");
      var payload = Success("probe");
      payload["point"] = PointPayload(x, y);
      var top = TopWindowAt(x, y);
      bool named = windowId.Length > 0;
      bool covered = false;
      bool pointInTarget = false;
      WindowInfo coverer = null;
      WindowInfo target = null;
      if (named) {
        // The window the caller named: the ONLY window this call may click.
        target = ResolveTarget(windowId);
        if (target == null) {
          // The named window does not exist. The window that happens to be on
          // top is NOT a substitute: the click would land on the wrong window.
          payload["windowFound"] = false;
          payload["covered"] = false;
          payload["coveredBy"] = null;
          payload["target"] = null;
          payload["top"] = Describe(top);
          payload["pointInTarget"] = false;
          payload["targetIsForeground"] = false;
          payload["code"] = "WINDOW_NOT_FOUND";
          return payload;
        }
        pointInTarget = target.Rect.Contains(x, y);
        if (top != null && top.Handle != target.Handle && pointInTarget) {
          // Another window sits on top of the point AND the point is on the
          // named window: that window really covers the target.
          covered = true;
          coverer = top;
        }
      } else {
        // No window was named: the window UNDER the point is the target. A
        // window that is visible but not activated is a legitimate target, so
        // it is never reported as a window that got in the way.
        target = top;
        if (target == null) {
          payload["windowFound"] = false;
          payload["covered"] = false;
          payload["coveredBy"] = null;
          payload["target"] = null;
          payload["top"] = null;
          payload["pointInTarget"] = false;
          payload["targetIsForeground"] = false;
          payload["code"] = "WINDOW_NOT_FOUND";
          return payload;
        }
        pointInTarget = true;
      }
      var foreground = GetForegroundWindow();
      bool targetIsForeground = foreground != IntPtr.Zero && target != null && GetAncestor(foreground, GA_ROOT) == target.Handle;
      payload["covered"] = covered;
      payload["coveredBy"] = Describe(coverer);
      payload["target"] = Describe(target);
      payload["top"] = Describe(top);
      payload["pointInTarget"] = pointInTarget;
      payload["windowFound"] = true;
      payload["targetIsForeground"] = targetIsForeground;
      return payload;
    }

    /// <summary>What does the screen look like at this point, right now?</summary>
    private static Dictionary<string, object> Snapshot(Dictionary<string, object> request) {
      int x = Number(request, "x", 0);
      int y = Number(request, "y", 0);
      int radius = Number(request, "radius", 24);
      if (radius < 1) radius = 1;
      if (radius > 200) radius = 200;
      string windowId = Text(request, "windowId", "");
      var target = ResolveTarget(windowId);
      var payload = Success("snapshot");
      var window = target != null ? (target.ClientRect.Width > 0 ? target.ClientRect : target.Rect) : new Rectangle(x - radius, y - radius, radius * 2, radius * 2);
      payload["window"] = Describe(target);
      payload["windowHash"] = HashArea(window);
      payload["localHash"] = HashArea(new Rectangle(x - radius, y - radius, radius * 2, radius * 2));
      payload["uia"] = UiaState(x, y);
      return payload;
    }

    /// <summary>Move the cursor to the point, without clicking.</summary>
    private static Dictionary<string, object> Hover(Dictionary<string, object> request) {
      int x = Number(request, "x", 0);
      int y = Number(request, "y", 0);
      var payload = Success("hover");
      bool moved = SetCursorPos(x, y);
      Thread.Sleep(40);
      payload["x"] = x;
      payload["y"] = y;
      payload["cursorMoved"] = moved;
      return payload;
    }

    /// <summary>The controls of a window whose accessible name matches.</summary>
    /// <summary>The elements the caller has seen, by their id.</summary>
    private static readonly Dictionary<string, AutomationElement> ElementCache = new Dictionary<string, AutomationElement>();

    /// <summary>How many ids have been handed out.</summary>
    private static int ElementCounter = 0;
    private static Dictionary<string, object> Find(Dictionary<string, object> request) {

      string windowId = Text(request, "windowId", "");
      string name = Text(request, "name", "");
      var payload = Success("find");
      payload["windowFound"] = false;
      payload["candidates"] = new List<object>();
      // A new reading replaces the old one: the ids of the previous reading
      // are gone with it.
      ElementCache.Clear();
      var target = ResolveTarget(windowId);
      if (target == null) {
        payload["code"] = "WINDOW_NOT_FOUND";
        return payload;
      }
      payload["windowFound"] = true;
      payload["target"] = Describe(target);
      // The enumeration runs here, in this thread, and its errors are reported
      // as they are: a failure that quietly answers "no candidates" is worse
      // than no answer at all, because the caller cannot tell it apart from
      // "this window has no such control".
      try {
        int attempt;
        int named;
        payload["candidates"] = FindByName(target.Handle, name, out attempt, out named);
        payload["attempt"] = attempt;
        payload["namedElements"] = named;
        // The content of a window that draws itself (Feishu for one) is only
        // there once the process has built its tree. Until then the tree holds
        // the shell only, and that is not the same as "the control is not there".
        payload["webContent"] = named >= EnoughNamedElements ? "ready" : "starting";
      } catch (Exception error) {
        payload["candidates"] = new List<object>();
        payload["error"] = error.ToString();
      }
      return payload;
    }

    /// <summary>The controls of a window whose accessible name matches.</summary>
    // How many named elements the tree should hold to be believed.
    private const int EnoughNamedElements = 50;

    // How often the tree is read before giving up.
    private const int FindAttempts = 3;

    /// <summary>The controls of a window whose accessible name may match.</summary>
    ///
    /// Some self-drawn applications (Feishu for one) only fill their
    /// accessibility tree after they have been read once with the official
    /// computer control channel: the first enumeration sees the shell only
    /// (tabs, minimise, close). So the tree is read again, a few times, until
    /// it holds enough named elements.
    ///
    /// The name is compared without its decoration: emoji, symbols and the
    /// text in brackets are dropped, so the wanted name also matches a name
    /// that carries them.
    private static List<object> FindByName(IntPtr windowHandle, string wanted, out int attempt, out int named) {
      var found = new List<object>();
      attempt = 0;
      named = 0;
      if (string.IsNullOrEmpty(wanted)) return found;
      for (attempt = 1; attempt <= FindAttempts; attempt += 1) {
        found = new List<object>();
        named = 0;
        var root = AutomationElement.FromHandle(windowHandle);
        if (root == null) return found;
        var collection = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        foreach (var raw in collection) {
          if (raw == null) continue;
          // The collection enumerates as plain objects, so the element is cast
          // back before its state is read.
          var element = (AutomationElement)raw;
          var current = element.Current;
          var elementName = PropertyText(current, "Name");
          if (elementName.Length == 0) continue;
          named += 1;
          if (!NameMayMatch(elementName, wanted)) continue;
          var candidate = new Dictionary<string, object>();
          candidate["name"] = elementName;
          candidate["automationId"] = PropertyText(current, "AutomationId");
          candidate["controlType"] = ControlTypeName(current);
          candidate["rect"] = RectangleText(current);
          candidate["level"] = ElementLevel(element);
          // The element gets an id, so the caller can come back for it by id
          // and tell two controls with the same name apart.
          ElementCounter += 1;
          var elementId = "e" + ElementCounter.ToString();
          ElementCache[elementId] = element;
          candidate["elementId"] = elementId;
          // A control that is off the screen cannot be clicked: the caller has
          // to scroll to it first.
          candidate["offscreen"] = PropertyBool(current, "IsOffscreen");
          found.Add(candidate);
        }
        if (named >= EnoughNamedElements) break;
        // The tree may not be filled yet: give the application a moment and
        // read it again.
        if (attempt < FindAttempts) Thread.Sleep(300);
      }
      // The visible candidates come first: the caller never wants the one
      // that is off the screen.
      var visible = new List<object>();
      var hidden = new List<object>();
      foreach (var candidate in found) {
        var map = (Dictionary<string, object>)candidate;
        bool off = map.ContainsKey("offscreen") && (bool)map["offscreen"];
        if (off) hidden.Add(candidate); else visible.Add(candidate);
      }
      var ordered = new List<object>();
      ordered.AddRange(visible);
      ordered.AddRange(hidden);
      return ordered;
    }

    /// <summary>The name without its decoration: letters, digits and CJK only.</summary>
    private static string NormalizeName(string text) {
      if (string.IsNullOrEmpty(text)) return "";
      var kept = new StringBuilder();
      foreach (var character in text) {
        if (char.IsLetterOrDigit(character)) kept.Append(char.ToLowerInvariant(character));
      }
      return kept.ToString();
    }

    /// <summary>May this name be the one the caller is looking for?</summary>
    private static bool NameMayMatch(string candidate, string wanted) {
      var a = NormalizeName(candidate);
      var b = NormalizeName(wanted);
      if (a.Length == 0 || b.Length == 0) return false;
      if (a.Contains(b) || b.Contains(a)) return true;
      int common = 0;
      while (common < a.Length && common < b.Length && a[common] == b[common]) common += 1;
      return common >= 2;
    }

    /// <summary>Run a control without moving the mouse.</summary>
    ///
    /// The element has to support the invoke pattern: the run then happens in
    /// the background, the mouse stays where it is and the window does not come
    /// to the front. When the control does not support it, the answer says so
    /// instead of pretending it ran.
    /// </summary>
    private static Dictionary<string, object> Invoke(Dictionary<string, object> request) {
      string elementId = Text(request, "elementId", "");
      var payload = Success("invoke");
      payload["ok"] = false;
      payload["canInvoke"] = false;
      payload["manner"] = "point";
      AutomationElement element;
      if (string.IsNullOrEmpty(elementId) || !ElementCache.TryGetValue(elementId, out element) || element == null) {
        payload["code"] = "ELEMENT_ID_EXPIRED";
        payload["error"] = "elementId " + elementId + " is not known any more: a new reading replaced it, read the window again and use the new id";
        return payload;
      }
      var current = element.Current;
      payload["name"] = PropertyText(current, "Name");
      payload["rect"] = RectangleText(current);
      payload["offscreen"] = PropertyBool(current, "IsOffscreen");
      object pattern;
      if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
        ((InvokePattern)pattern).Invoke();
        payload["ok"] = true;
        payload["canInvoke"] = true;
        payload["manner"] = "invoke";
        return payload;
      }
      payload["code"] = "NO_INVOKE_PATTERN";
      payload["error"] = "this control does not support the invoke pattern: click it by its point instead";
      return payload;
    }

    /// <summary>How deep an element sits in the tree of its window.</summary>
    private static int ElementLevel(AutomationElement element) {
      int level = 0;
      var current = element;
      for (; level < 32; level += 1) {
        var parent = TreeWalker.ControlViewWalker.GetParent(current);
        if (parent == null) break;
        current = parent;
      }
      return level;
    }

    /// <summary>A real mouse click at the point.</summary>
    private static Dictionary<string, object> Click(Dictionary<string, object> request) {
      int x = Number(request, "x", 0);
      int y = Number(request, "y", 0);
      long expectHandle = Number(request, "expectHandle", 0);
      var payload = Success("click");
      // The point is looked at ONE more time right before the click: a window
      // that appeared in between must not receive the click.
      payload["reconfirmed"] = false;
      if (expectHandle != 0) {
        var top = TopWindowAt(x, y);
        if (top == null || top.Handle.ToInt64() != expectHandle) {
          payload["ok"] = false;
          payload["code"] = "POINT_COVERED";
          payload["coveredBy"] = Describe(top);
          payload["clicked"] = false;
          payload["reconfirmed"] = true;
          return payload;
        }
        payload["reconfirmed"] = true;
      }
      bool moved = SetCursorPos(x, y);
      Thread.Sleep(60);
      SendLeftClick();
      payload["x"] = x;
      payload["y"] = y;
      payload["cursorMoved"] = moved;
      payload["clicked"] = true;
      return payload;
    }

    /// <summary>The window the caller means: a handle, a title fragment, or the foreground.</summary>
    private static WindowInfo ResolveTarget(string windowId) {
      if (windowId == null) windowId = "";
      windowId = windowId.Trim();
      if (windowId.Length == 0) {
        var foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return null;
        return DescribeWindow(GetAncestor(foreground, GA_ROOT));
      }
      IntPtr handle;
      if (TryParseHandle(windowId, out handle) && IsWindow(handle)) {
        return DescribeWindow(GetAncestor(handle, GA_ROOT));
      }
      return FindWindowByTitle(windowId);
    }

    /// <summary>The top level window that sits on the point.</summary>
    private static WindowInfo TopWindowAt(int x, int y) {
      var window = WindowFromPoint(new Point(x, y));
      if (window == IntPtr.Zero) return null;
      return DescribeWindow(GetAncestor(window, GA_ROOT));
    }

    private static WindowInfo FindWindowByTitle(string fragment) {
      WindowInfo found = null;
      EnumWindows(delegate(IntPtr window, IntPtr data) {
        if (!IsWindowVisible(window)) return true;
        var title = WindowTitle(window);
        if (title.Length == 0) return true;
        if (title.IndexOf(fragment, StringComparison.OrdinalIgnoreCase) < 0) return true;
        found = DescribeWindow(window);
        return false;
      }, IntPtr.Zero);
      return found;
    }

    private static bool TryParseHandle(string text, out IntPtr handle) {
      handle = IntPtr.Zero;
      try {
        long value;
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
          string digits = text.Substring(2);
          if (!Int64.TryParse(digits, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value)) return false;
        } else {
          if (!Int64.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return false;
        }
        handle = new IntPtr(value);
        return true;
      } catch {
        handle = IntPtr.Zero;
        return false;
      }
    }

    private static WindowInfo DescribeWindow(IntPtr window) {
      if (window == IntPtr.Zero) return null;
      var info = new WindowInfo();
      info.Handle = window;
      info.Title = WindowTitle(window);
      info.ClassName = WindowClass(window);
      info.ClientRect = ClientRectOf(window);
      RECT rect;
      if (GetWindowRect(window, out rect)) {
        info.Rect = new Rectangle(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
      }
      return info;
    }

    private static string WindowTitle(IntPtr window) {
      var text = new StringBuilder(512);
      GetWindowText(window, text, text.Capacity);
      return text.ToString();
    }

    private static string WindowClass(IntPtr window) {
      var text = new StringBuilder(256);
      GetClassName(window, text, text.Capacity);
      return text.ToString();
    }

    private static Dictionary<string, object> Describe(WindowInfo info) {
      if (info == null) return null;
      var payload = new Dictionary<string, object>();
      payload["handle"] = info.Handle.ToInt64();
      payload["title"] = info.Title;
      payload["class"] = info.ClassName;
      var rect = new Dictionary<string, object>();
      rect["x"] = info.Rect.X;
      rect["y"] = info.Rect.Y;
      rect["width"] = info.Rect.Width;
      rect["height"] = info.Rect.Height;
      payload["rect"] = rect;
      var client = new Dictionary<string, object>();
      client["x"] = info.ClientRect.X;
      client["y"] = info.ClientRect.Y;
      client["width"] = info.ClientRect.Width;
      client["height"] = info.ClientRect.Height;
      payload["clientRect"] = client;
      return payload;
    }

    private static Dictionary<string, object> PointPayload(int x, int y) {
      var payload = new Dictionary<string, object>();
      payload["x"] = x;
      payload["y"] = y;
      return payload;
    }

    /// <summary>The client area of a window, in screen coordinates.</summary>
    private static Rectangle ClientRectOf(IntPtr window) {
      RECT client;
      if (!GetClientRect(window, out client)) return Rectangle.Empty;
      POINT origin;
      origin.X = client.Left;
      origin.Y = client.Top;
      if (!ClientToScreen(window, ref origin)) return Rectangle.Empty;
      return new Rectangle(origin.X, origin.Y, client.Right - client.Left, client.Bottom - client.Top);
    }

    /// <summary>A hash of the pixels of an area of the screen.</summary>
    private static string HashArea(Rectangle area) {
      Rectangle clipped = Rectangle.Intersect(area, System.Windows.Forms.SystemInformation.VirtualScreen);
      if (clipped.Width <= 0 || clipped.Height <= 0) return "";
      using (var bitmap = new Bitmap(clipped.Width, clipped.Height, PixelFormat.Format32bppArgb))
      using (var graphics = Graphics.FromImage(bitmap)) {
        graphics.CopyFromScreen(clipped.X, clipped.Y, 0, 0, clipped.Size, CopyPixelOperation.SourceCopy);
        var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
          var bytes = new byte[data.Stride * data.Height];
          Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
          using (var sha = SHA256.Create()) {
            var hash = sha.ComputeHash(bytes);
            var text = new StringBuilder(hash.Length * 2);
            for (int i = 0; i < hash.Length; i++) text.Append(hash[i].ToString("x2", CultureInfo.InvariantCulture));
            return text.ToString();
          }
        } finally {
          bitmap.UnlockBits(data);
        }
      }
    }

    /// <summary>An assembly by simple name: the loaded one first, then the loader.</summary>
    private static Assembly FindAssembly(string name) {
      foreach (var loaded in AppDomain.CurrentDomain.GetAssemblies()) {
        try {
          if (loaded.GetName().Name == name) return loaded;
        } catch {
          /* an assembly without a name */
        }
      }
      return Assembly.Load(name);
    }

    /// <summary>The UIA state of the element under the point (null when UIA is not there).</summary>
    private static Dictionary<string, object> UiaState(int x, int y) {
      var state = new Dictionary<string, object>[1];
      var failure = new Exception[1];
      var worker = new Thread(delegate() {
        try {
          state[0] = UiaStateCore(x, y);
        } catch (Exception error) {
          failure[0] = error;
        }
      });
      worker.IsBackground = true;
      worker.Start();
      if (!worker.Join(2000)) return null;
      if (failure[0] != null) return null;
      return state[0];
    }

    /// <summary>
    /// The UIA types live in assemblies this file does not reference, so they are
    /// loaded and called by reflection: the helper then still starts on a machine
    /// where the UI Automation assemblies are missing.
    /// </summary>
    private static Dictionary<string, object> UiaStateCore(int x, int y) {
      var automation = FindAssembly("UIAutomationClient");
      var baseAssembly = FindAssembly("WindowsBase");
      var elementType = automation.GetType("System.Windows.Automation.AutomationElement");
      var pointType = baseAssembly.GetType("System.Windows.Point");
      if (elementType == null || pointType == null) return null;
      var point = Activator.CreateInstance(pointType, new object[] { (double)x, (double)y });
      var fromPoint = elementType.GetMethod("FromPoint", new Type[] { pointType });
      if (fromPoint == null) return null;
      var element = fromPoint.Invoke(null, new object[] { point });
      if (element == null) return null;
      var current = elementType.GetProperty("Current").GetValue(element, null);
      if (current == null) return null;
      var state = new Dictionary<string, object>();
      state["name"] = PropertyText(current, "Name");
      state["automationId"] = PropertyText(current, "AutomationId");
      state["controlType"] = ControlTypeName(current);
      state["enabled"] = PropertyBool(current, "IsEnabled");
      state["focused"] = PropertyBool(current, "HasKeyboardFocus");
      state["offscreen"] = PropertyBool(current, "IsOffscreen");
      state["rect"] = RectangleText(current);
      return state;
    }

    private static string PropertyText(object source, string name) {
      try {
        var property = source.GetType().GetProperty(name);
        if (property == null) return "";
        var value = property.GetValue(source, null);
        if (value == null) return "";
        return Convert.ToString(value, CultureInfo.InvariantCulture);
      } catch {
        return "";
      }
    }

    private static bool PropertyBool(object source, string name) {
      try {
        var property = source.GetType().GetProperty(name);
        if (property == null) return false;
        var value = property.GetValue(source, null);
        if (value == null) return false;
        return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
      } catch {
        return false;
      }
    }

    private static string ControlTypeName(object current) {
      try {
        var property = current.GetType().GetProperty("ControlType");
        if (property == null) return "";
        var controlType = property.GetValue(current, null);
        if (controlType == null) return "";
        return PropertyText(controlType, "ProgrammaticName");
      } catch {
        return "";
      }
    }

    private static Dictionary<string, object> RectangleText(object current) {
      var rect = new Dictionary<string, object>();
      try {
        var property = current.GetType().GetProperty("BoundingRectangle");
        if (property == null) return rect;
        var box = property.GetValue(current, null);
        if (box == null) return rect;
        rect["x"] = (int)Math.Round(Convert.ToDouble(box.GetType().GetProperty("X").GetValue(box, null), CultureInfo.InvariantCulture));
        rect["y"] = (int)Math.Round(Convert.ToDouble(box.GetType().GetProperty("Y").GetValue(box, null), CultureInfo.InvariantCulture));
        rect["width"] = (int)Math.Round(Convert.ToDouble(box.GetType().GetProperty("Width").GetValue(box, null), CultureInfo.InvariantCulture));
        rect["height"] = (int)Math.Round(Convert.ToDouble(box.GetType().GetProperty("Height").GetValue(box, null), CultureInfo.InvariantCulture));
      } catch {
        /* the rectangle is a nicety: the state is still worth reporting */
      }
      return rect;
    }

    private static void SendLeftClick() {
      var inputs = new INPUT[2];
      inputs[0].type = INPUT_MOUSE;
      inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
      inputs[1].type = INPUT_MOUSE;
      inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
      SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    private static string ToJson(Dictionary<string, object> payload) {
      return EscapeNonAscii(Serializer.Serialize(payload));
    }

    /// <summary>Everything outside ASCII becomes a \\u escape, so the pipe stays plain ASCII.</summary>
    private static string EscapeNonAscii(string text) {
      var builder = new StringBuilder(text.Length + 32);
      foreach (char c in text) {
        if (c >= 0x20 && c < 0x7F) { builder.Append(c); continue; }
        builder.Append("\\u");
        builder.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      }
      return builder.ToString();
    }

    private static Dictionary<string, object> Success(string command) {
      var payload = new Dictionary<string, object>();
      payload["ok"] = true;
      payload["command"] = command;
      payload["id"] = currentId;
      return payload;
    }

    private static Dictionary<string, object> Failure(string message) {
      var payload = new Dictionary<string, object>();
      payload["ok"] = false;
      payload["error"] = message;
      payload["id"] = currentId;
      return payload;
    }

    private static string Text(Dictionary<string, object> request, string key, string fallback) {
      object value;
      if (request == null || !request.TryGetValue(key, out value) || value == null) return fallback;
      string text = Convert.ToString(value, CultureInfo.InvariantCulture);
      return text == null ? fallback : text;
    }

    private static int Number(Dictionary<string, object> request, string key, int fallback) {
      object value;
      if (request == null || !request.TryGetValue(key, out value) || value == null) return fallback;
      try {
        return Convert.ToInt32(value, CultureInfo.InvariantCulture);
      } catch {
        return fallback;
      }
    }

    // --- the Windows API this helper needs -------------------------------
    private const uint GA_ROOT = 2;
    private const uint INPUT_MOUSE = 0;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public MOUSEINPUT mi; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
      public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref POINT point);

    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  }

  /// <summary>One window: its handle, its title and where it is.</summary>
  internal sealed class WindowInfo {
    public IntPtr Handle;
    public string Title = "";
    public string ClassName = "";
    public Rectangle Rect;
    public Rectangle ClientRect;
  }
}
