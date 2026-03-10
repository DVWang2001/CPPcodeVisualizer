/*
Animations.tsx就是用來給我弄視覺化的
*/

import React from "react";
import { global_variable } from "./global_variable";
import { store } from "statorgfc";

type State = any;

class Visualizer extends React.Component<{}, State> {
  updateInterval: any;
  constructor() {
    // @ts-expect-error ts-migrate(2554) FIXME: Expected 1-2 arguments, but got 0.
    super();
    // @ts-expect-error ts-migrate(2339) FIXME: Property 'connectComponentState' does not exist on... Remove this comment to see the full error message
    store.connectComponentState(this, [
      "current_theme",
    ]);
  }
  static clear() {
    if ("__guide" in global_variable) {
      (global_variable as any).__guide.clear();
    }
    if ("__containers_guide" in global_variable) {
      (global_variable as any).__containers_guide.clear();
    }
  }
  renderGuideTable() {
    const guide = (global_variable as any).__guide as Map<string, any[]>;
    if (!guide || guide.size === 0) {
      return <div>No guide data available</div>;
    }
    // 水平表格
    const maxValues = Math.max(...Array.from(guide.values()).map(v => v.length));
    const rows = Array.from(guide.entries()).map(([key, values]) => {
      const cells = [<td key="expr" style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{key}</td>];
      for (let i = 0; i < maxValues; i++) {
        cells.push(<td key={i} style={{ border: '1px solid black', padding: '8px', textAlign: 'center' }}>{values[i] || ''}</td>);
      }
      return <tr key={key}>{cells}</tr>;
    });
    return (
      <table style={{ width: '100%', border: '1px solid black', borderCollapse: 'collapse' }}>
        <tbody>{rows}</tbody>
      </table>
    );
  }


  renderSourceCode() {
    const sourceCode = (global_variable as any).__source_code;
    const fullname = (global_variable as any).__source_code_fullname;
    const guide = (global_variable as any).__guide as Map<string, any[]>;
    if (!sourceCode) {
      return <div>No source code available</div>;
    }

    // Calculate max guide length
    const allGuideData = Object.keys(sourceCode).map(lineNum => guide ? guide.get(lineNum) : undefined).filter(g => g && g.length > 0);
    const maxGuideLength = allGuideData.length > 0 ? Math.max(...allGuideData.map(g => g!.length)) : 0;
    const rows = Object.entries(sourceCode).map(([lineNum, code]) => {
      const guideData = guide ? guide.get(lineNum) : undefined;
      const guideCells = [];
      for (let i = 0; i < maxGuideLength; i++) {
        const valueStr = guideData && guideData[i] ? guideData[i] : '';
        let cellContent: any = valueStr;

        if (typeof valueStr === 'string' && valueStr.startsWith('{') && valueStr.includes('"type"')) {
          try {
            const data = JSON.parse(valueStr);
            if (data.values) {
              cellContent = <span style={{ fontFamily: 'monospace', color: 'blue' }}>{`{${data.values.join(', ')}}`}</span>;
            } else {
              cellContent = <span style={{ fontFamily: 'monospace', color: 'blue' }}>{valueStr}</span>;
            }
          } catch (e) {
            // JSON 解析失敗，回退成純字串
            cellContent = <span style={{ fontFamily: 'monospace', color: 'blue' }}>{valueStr}</span>;
          }
        } else if (valueStr) {
          cellContent = <span style={{ fontFamily: 'monospace', color: 'blue' }}>{valueStr}</span>;
        }

        guideCells.push(<td key={i} style={{ padding: '8px' }}>{cellContent}</td>);
      }
      return (
        <tr key={lineNum}>
          <td style={{ padding: '4px', textAlign: 'right', width: '50px' }}>{lineNum}</td>
          <td style={{ padding: '4px', fontFamily: 'monospace', whiteSpace: 'pre' }}><span className="wsp" dangerouslySetInnerHTML={{ __html: code as string }} /></td>
          {guideCells}
        </tr>
      );
    });
    return (
      <div style={{ padding: '4px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>{rows}</tbody>
        </table>
      </div>
    );
  }

  render() {
    return (
      <div className={this.state.current_theme}>
        {this.renderSourceCode()}
      </div>
    );
  }
  componentDidMount() {
    this.updateInterval = setInterval(() => this.forceUpdate(), 1000);
  }
  componentWillUnmount() {
    if (this.updateInterval) clearInterval(this.updateInterval);
  }
}
export default Visualizer;