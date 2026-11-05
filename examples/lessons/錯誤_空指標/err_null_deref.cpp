// 錯誤教案 #5：空指標解參考（走到鏈結串列尾端還去讀 next 的值）
#include <iostream>

struct Node {
  int val;                               //@ @guide val 是節點的值 
  Node* next;                            //@ @guide next 指向下一個節點；最後一個節點的 next 是空指標（nullptr） 
};

int main() {                             //@ @tts [next] 程式開始，我們要建立一條只有兩個節點的鏈結串列
  Node b{20, nullptr};                   //@ @tts [next] 建立節點 b，值是 20，它的 next 是空指標
  Node a{10, &b};                        //@ @tts [next] 建立節點 a，值是 10，它的 next 指向 b
  Node* cur = &a;                        //@ @tts [next] cur 從 a 開始走
  while (cur != nullptr) {               //@ @tts [next] 只要 cur 不是空指標，就印出它
    std::cout << "值：" << cur->val << std::endl;  //@ @tts [next] 印出目前節點的值
    std::cout << "下一個值：" << cur->next->val << std::endl;  //@ @bug 走到最後一個節點時，next 是空指標。這裡讀 cur->next->val，等於解參考空指標。原生 Linux 會崩潰；本環境讀到 0，不會崩潰 @tts [next] 讀下一個節點的值，但最後一個節點沒有下一個
    cur = cur->next;                     //@ @tts [next] cur 前進到下一個節點
  }                                      //@ @tts [next] 迴圈結束
  return 0;                              //@ @tts [next] 回傳 0，main 即將結束
}  //@ @tts [continue] 教案播放完畢
